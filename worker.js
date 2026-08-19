/* Entry point when this is deployed as a Cloudflare Worker.
 *
 * Cloudflare merged Workers and Pages, and a Git-connected project now comes
 * out as a Worker - which ignores the functions/ directory that Pages uses. So
 * the routing lives here instead, over the same proxy module, and the project
 * works either way.
 *
 *   /api/*, /media/*  ->  the VM, via ORIGIN
 *   everything else   ->  the static app out of public/
 */
import { proxy } from './functions/_proxy.js';

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/') || pathname.startsWith('/media/')) {
      return proxy({ request, env });
    }
    // Served from Cloudflare's own network, so only the data touches the VM.
    return env.ASSETS.fetch(request);
  }
};
