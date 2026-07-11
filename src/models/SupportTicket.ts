import mongoose, { Schema, Document } from 'mongoose';

export interface IMessage {
  sender: 'user' | 'admin';
  text: string;
  attachmentUrl?: string;
  createdAt: Date;
}

export interface ISupportTicket extends Document {
  guestId: string;
  userId?: mongoose.Types.ObjectId;
  displayName: string;
  messages: IMessage[];
  status: 'open' | 'closed';
  createdAt: Date;
  updatedAt: Date;
}

const MessageSchema = new Schema({
  sender: { type: String, enum: ['user', 'admin'], required: true },
  text: { type: String, required: true },
  attachmentUrl: { type: String },
  createdAt: { type: Date, default: Date.now }
});

const SupportTicketSchema = new Schema({
  guestId: { type: String, required: true, unique: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User' },
  displayName: { type: String, required: true },
  messages: [MessageSchema],
  status: { type: String, enum: ['open', 'closed'], default: 'open' },
}, { timestamps: true });

export const SupportTicket = mongoose.model<ISupportTicket>('SupportTicket', SupportTicketSchema);
