/* Everything under /api - accounts, the quiz, and the live feed. */
import { proxy } from '../_proxy.js';
export const onRequest = proxy;
