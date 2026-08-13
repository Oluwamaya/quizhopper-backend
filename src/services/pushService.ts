import webpush from 'web-push';
import { User } from '../models/User';
import { env } from '../config/env';

const VAPID_PUBLIC_KEY = env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL = env.VAPID_EMAIL;

// Initialize web-push if keys are provided
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    VAPID_EMAIL,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
  console.log('Web Push service configured successfully!');
} else {
  console.warn(
    'WARNING: VAPID keys missing in env. Web Push notifications will be inactive. Generate them with: npx web-push generate-vapid-keys'
  );
}

// Register a push subscription for a user
export const registerSubscription = async (userId: string, subscription: any) => {
  try {
    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');

    // Prevent duplicate subscriptions
    const exists = user.pushSubscriptions.some(sub => sub.endpoint === subscription.endpoint);
    if (!exists) {
      user.pushSubscriptions.push(subscription);
      await user.save();
    }
    return { success: true };
  } catch (err: any) {
    console.error('Error saving subscription:', err);
    throw err;
  }
};

// Send a push notification to a specific user across all their registered browser subscriptions
export const sendPushNotification = async (userId: string, payload: { title: string; body: string; url?: string }) => {
  try {
    const user = await User.findById(userId);
    if (!user || user.pushSubscriptions.length === 0) return;

    const notificationPayload = JSON.stringify({
      notification: {
        title: payload.title,
        body: payload.body,
        icon: '/images/log.jpg',
        badge: '/images/log.jpg',
        data: {
          url: payload.url || '/'
        }
      }
    });

    const failedSubscriptions: string[] = [];

    // Send push to all browser connections for this user
    const sendPromises = user.pushSubscriptions.map(async (sub) => {
      try {
        // Cast to web-push push subscription format
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: {
              auth: sub.keys.auth,
              p256dh: sub.keys.p256dh
            }
          },
          notificationPayload
        );
      } catch (err: any) {
        // If subscription is expired (410) or invalid (404), mark for pruning
        if (err.statusCode === 410 || err.statusCode === 404) {
          failedSubscriptions.push(sub.endpoint);
        } else {
          console.error('Error sending push to endpoint:', sub.endpoint, err);
        }
      }
    });

    await Promise.all(sendPromises);

    // Prune dead subscriptions
    if (failedSubscriptions.length > 0) {
      user.pushSubscriptions = user.pushSubscriptions.filter(
        sub => !failedSubscriptions.includes(sub.endpoint)
      );
      await user.save();
      console.log(`Pruned ${failedSubscriptions.length} dead push subscriptions for user ${userId}`);
    }
  } catch (err) {
    console.error('Error in sendPushNotification service:', err);
  }
};
