import mongoose from 'mongoose';
import { env } from './config.js';

export async function connectDatabase(): Promise<void> {
  await mongoose.connect(env.MONGO_URI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
  });
  console.log('Connected to MongoDB');
}

export async function disconnectDatabase(): Promise<void> {
  console.log('Disconnected from MongoDB');
  await mongoose.disconnect();
}
