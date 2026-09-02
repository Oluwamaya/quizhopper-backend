import { Request, Response } from 'express';
import crypto from 'crypto';
import { User } from '../models/User';
import { WalletTransaction } from '../models/WalletTransaction';
import { AuthRequest } from '../middlewares/authMiddleware';
import { env } from '../config/env';
import { getCache, acquireOnce } from '../services/redisService';
import { emitAdminTransaction } from '../utils/adminEvents';

const PAYSTACK_SECRET_KEY = env.PAYSTACK_SECRET_KEY;
const PAYSTACK_PUBLIC_KEY = env.PAYSTACK_PUBLIC_KEY;

// Idempotency guard for processed payment references — Redis-backed (with
// in-memory fallback) so it's shared across instances instead of living on
// whichever single process happened to handle the request. This is a fast
// dedup guard; the WalletTransaction.reference unique DB index below is the
// actual correctness guarantee if this check is ever bypassed (e.g. a
// Redis outage falling back to a fresh local cache on a new instance).
const REFERENCE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const referenceCacheKey = (reference: string) => `paystack:ref:${reference}`;

// 1. Initialize Paystack Transaction
export const initializePaystackDeposit = async (req: AuthRequest, res: Response) => {
  try {
    const { amount } = req.body;
    const userId = req.userId;

    if (!amount || typeof amount !== 'number' || !Number.isFinite(amount) || amount < 100 || amount > 5000000) {
      return res.status(400).json({ success: false, message: 'Deposit amount must be between ₦ 100 and ₦ 5,000,000' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User account not found' });
    }

    const reference = `ref_paystack_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const amountInKobo = Math.round(amount * 100);

    const paystackPayload: Record<string, any> = {
      email: user.email,
      amount: amountInKobo,
      currency: 'NGN',
      reference,
      metadata: {
        userId: user._id.toString(),
        amountNaira: amount,
        displayName: user.displayName
      }
    };

    // Route settlement to the configured subaccount when set. The
    // subaccount itself is configured on Paystack's side with
    // percentage_charge: 0, so no transaction_charge/split percentage is
    // needed here — bearer: 'subaccount' just makes the subaccount (rather
    // than the main account) responsible for Paystack's transaction fees.
    if (env.SUBACCOUNT_CODE) {
      paystackPayload.subaccount = env.SUBACCOUNT_CODE;
      paystackPayload.bearer = 'subaccount';
    }

    // Make API call to Paystack API
    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(paystackPayload)
    });

    const data: any = await response.json();

    if (!data.status) {
      // Return dev mock fallback if invalid secret key is used in development
      return res.status(200).json({
        success: true,
        message: 'Paystack checkout session created',
        authorizationUrl: `https://checkout.paystack.com/${reference}`,
        accessCode: `access_${reference}`,
        reference,
        publicKey: PAYSTACK_PUBLIC_KEY
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Paystack checkout session initialized',
      authorizationUrl: data.data.authorization_url,
      accessCode: data.data.access_code,
      reference: data.data.reference,
      publicKey: PAYSTACK_PUBLIC_KEY
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// 2. Verify Paystack Transaction Reference
export const verifyPaystackDeposit = async (req: AuthRequest, res: Response) => {
  try {
    const { reference } = req.params;
    const userId = req.userId;

    if (!reference || typeof reference !== 'string') {
      return res.status(400).json({ success: false, message: 'Transaction reference is required' });
    }

    const alreadyProcessed = await getCache(referenceCacheKey(reference));
    if (alreadyProcessed) {
      const user = await User.findById(userId);
      return res.status(200).json({
        success: true,
        message: 'Transaction already verified and credited',
        amountCredited: 0,
        user: {
          id: user?._id,
          displayName: user?.displayName,
          email: user?.email,
          balance: user?.balance,
          coins: user?.coins
        }
      });
    }

    if (!PAYSTACK_SECRET_KEY) {
      return res.status(503).json({ success: false, message: 'Payment provider is not configured. Please contact support.' });
    }

    // Call Paystack verify API. There is no safe fallback here — if this
    // call fails or the transaction isn't confirmed successful, the deposit
    // must NOT be credited. Crediting on failure would let anyone mint
    // wallet balance for free with a bogus reference.
    let verifyData: any;
    try {
      const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`
        }
      });
      verifyData = await response.json();
    } catch (e) {
      return res.status(502).json({ success: false, message: 'Unable to reach payment provider. Please try again shortly.' });
    }

    if (!verifyData?.status || verifyData.data?.status !== 'success') {
      return res.status(400).json({ success: false, message: 'Payment was not successful or could not be verified.' });
    }

    const verifiedAmountNaira = Number(verifyData.data.amount) / 100;
    if (!Number.isFinite(verifiedAmountNaira) || verifiedAmountNaira <= 0) {
      return res.status(400).json({ success: false, message: 'Payment amount could not be verified.' });
    }

    // Ensure the transaction actually belongs to the requesting user, so a
    // reference cannot be replayed by a different account to steal a
    // deposit meant for someone else.
    const transactionOwnerId = verifyData.data.metadata?.userId;
    if (transactionOwnerId && transactionOwnerId !== userId) {
      return res.status(403).json({ success: false, message: 'This transaction does not belong to your account.' });
    }

    // Atomically claim this reference — if another concurrent request (or
    // another instance) already claimed it, fall back to the DB unique
    // index below rather than crediting twice.
    await acquireOnce(referenceCacheKey(reference), REFERENCE_TTL_SECONDS);

    // Record the ledger entry first — `reference` has a unique index, so a
    // duplicate-credit race is rejected here at the database layer even if
    // the idempotency guard above were ever bypassed (e.g. a Redis outage).
    // Only credit the balance once the ledger write succeeds.
    try {
      const txn = await WalletTransaction.create({
        user: userId,
        type: 'deposit',
        amountMoney: verifiedAmountNaira,
        coinsChange: 0,
        description: 'Paystack Wallet Deposit (Naira)',
        reference,
        status: 'completed'
      });
      emitAdminTransaction(req.app.get('socketio'), txn);
    } catch (err: any) {
      if (err.code === 11000) {
        const user = await User.findById(userId);
        return res.status(200).json({
          success: true,
          message: 'Transaction already verified and credited',
          amountCredited: 0,
          user: user
            ? { id: user._id, displayName: user.displayName, email: user.email, balance: user.balance, coins: user.coins }
            : undefined
        });
      }
      throw err;
    }

    const updatedUser = await User.findByIdAndUpdate(userId, { $inc: { balance: verifiedAmountNaira } }, { new: true });

    return res.status(200).json({
      success: true,
      message: `Deposit of ₦ ${verifiedAmountNaira.toLocaleString()} verified successfully!`,
      amountCredited: verifiedAmountNaira,
      user: {
        id: updatedUser?._id,
        displayName: updatedUser?.displayName,
        email: updatedUser?.email,
        balance: updatedUser?.balance,
        coins: updatedUser?.coins
      }
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// 3. Webhook listener for automatic background verification
export const handlePaystackWebhook = async (req: Request, res: Response) => {
  try {
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(503).send('Payment provider is not configured');
    }

    // The signature header is mandatory, not optional — without this check
    // anyone could POST a fake charge.success event and credit any wallet.
    const signature = req.headers['x-paystack-signature'];
    if (!signature || typeof signature !== 'string') {
      return res.status(400).send('Missing signature');
    }

    const rawBody: Buffer | undefined = (req as any).rawBody;
    if (!rawBody) {
      return res.status(400).send('Missing request body');
    }

    const expectedHash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(rawBody).digest('hex');

    const signatureBuffer = Buffer.from(signature, 'utf8');
    const expectedBuffer = Buffer.from(expectedHash, 'utf8');
    const isValidSignature =
      signatureBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(signatureBuffer, expectedBuffer);

    if (!isValidSignature) {
      return res.status(400).send('Invalid signature');
    }

    const event = req.body;
    if (event && event.event === 'charge.success') {
      const ref = event.data.reference;
      const userId = event.data.metadata?.userId;
      const amountNaira = Number(event.data.amount) / 100;

      const claimed =
        ref && userId && Number.isFinite(amountNaira) && amountNaira > 0
          ? await acquireOnce(referenceCacheKey(ref), REFERENCE_TTL_SECONDS)
          : false;

      if (claimed) {
        try {
          const txn = await WalletTransaction.create({
            user: userId,
            type: 'deposit',
            amountMoney: amountNaira,
            coinsChange: 0,
            description: 'Paystack Direct Webhook Deposit',
            reference: ref,
            status: 'completed'
          });
          emitAdminTransaction(req.app.get('socketio'), txn);
          await User.findByIdAndUpdate(userId, { $inc: { balance: amountNaira } });
          console.log(`WEBHOOK SUCCESS: ₦ ${amountNaira} credited to user ${userId}`);
        } catch (err: any) {
          if (err.code !== 11000) throw err; // duplicate reference — already credited, ignore
        }
      }
    }

    return res.status(200).json({ status: 'success' });
  } catch (error: any) {
    return res.status(500).send(error.message);
  }
};

// 4. Retrieve User Wallet Transaction Ledger History (paginated)
export const getWalletTransactions = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string, 10) || 10));

    const totalCount = await WalletTransaction.countDocuments({ user: userId });
    const transactions = await WalletTransaction.find({ user: userId })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    return res.status(200).json({
      success: true,
      count: transactions.length,
      transactions,
      page,
      limit,
      totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / limit))
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
