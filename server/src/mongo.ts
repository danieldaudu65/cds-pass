import { MongoClient, type Collection, type Document } from 'mongodb';

let clientPromise: Promise<MongoClient> | null = null;

export function mongoConfigured() {
  return Boolean(process.env.MONGODB_URI);
}

export async function mongoCollection<T extends Document = Document>(name: string): Promise<Collection<T>> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not configured.');
  if (!clientPromise) {
    const client = new MongoClient(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 8000 });
    clientPromise = client.connect().catch((error) => {
      clientPromise = null;
      throw error;
    });
  }
  const client = await clientPromise;
  return client.db(process.env.MONGODB_DATABASE || 'cds_pass').collection<T>(name);
}
