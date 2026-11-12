import { initializeApp, getApps } from 'firebase/app';
import {
  initializeAuth,
  inMemoryPersistence,
  signInAnonymously,
} from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { firebaseConfig } from './config.js';

// Private per-tab identity shared by signaling and authenticated Quick Match.
export class FirebaseIdentity {
  constructor() {
    this.db = null;
    this.auth = null;
    this.identityPromise = null;
  }
  async identity() {
    if (
      !firebaseConfig.projectId ||
      firebaseConfig.projectId.includes('YOUR_') ||
      !firebaseConfig.apiKey ||
      firebaseConfig.apiKey.includes('YOUR_')
    ) {
      throw new Error(
        'Configure your new Firebase project in online_2v2/config.js. See ONLINE_SETUP.md.'
      );
    }
    if (!this.identityPromise) {
      this.identityPromise = (async () => {
        const app =
          getApps().find((item) => item.name === 'online-2v2-tabs') ||
          initializeApp(firebaseConfig, 'online-2v2-tabs');
        // Initialize with NONE persistence before anything can restore a shared user.
        // Each tab gets its own identity, including duplicated tabs/windows.
        this.auth = initializeAuth(app, { persistence: inMemoryPersistence });
        this.db = getFirestore(app);
        if (!this.auth.currentUser) await signInAnonymously(this.auth);
        return this.auth.currentUser.uid;
      })().catch((error) => {
        this.identityPromise = null;
        throw error;
      });
    }
    return this.identityPromise;
  }
  async token() {
    await this.identity();
    return this.auth.currentUser.getIdToken();
  }
}
