/* Uploaded pictures, sound and video. These need the session cookie, which
   rides along with the request like any other. */
import { proxy } from '../_proxy.js';
export const onRequest = proxy;
