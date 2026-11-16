import { parseMetadataUri } from '../../sources/metadata/uri.js';

/**
 * The image reference stored for a coin, without a gateway host:
 *
 * - IPFS content (`ipfs://<cid>/<path>`, a path gateway URL or a subdomain
 *   gateway URL) becomes `ipfs://<cid>[/<path>]`.
 * - Arweave content (`ar://<id>` or an arweave.net URL) becomes `ar://<id>[/<path>]`.
 * - Any other http(s) URL is kept as written.
 * - Anything else, including an address that cannot be parsed, is null.
 *
 * Query strings and fragments on gateway URLs are dropped; they name the
 * gateway's behaviour (`?filename=...`), not the content. No image is fetched.
 */
export function imageReference(image: string | null): string | null {
  if (image === null) return null;
  const parsed = parseMetadataUri(image);
  switch (parsed.kind) {
    case 'ipfs':
      return `ipfs://${parsed.cid}${parsed.path}`;
    case 'arweave':
      return `ar://${parsed.id}${parsed.path}`;
    case 'http':
      return image.trim();
    case 'unsupported':
      return null;
  }
}
