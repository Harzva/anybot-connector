// Bounded request-body reading for the HTTP binding (Kimi-owned).
import { ConnectorError } from '../../contract.mjs';

// Reads at most limit bytes into memory; resolves with the buffered body.
// If the body exceeds limit, the remainder is drained up to a slack cap so
// the response can still be delivered cleanly on a healthy connection, then
// the read rejects with INVALID_ARGUMENT. Truly abusive bodies hit the slack
// cap and the connection is torn down.
export function readBoundedBody(req, limit, slack = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    let drained = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      received += chunk.length;
      if (received <= limit) {
        chunks.push(chunk);
        return;
      }
      drained += chunk.length;
      if (drained > slack) {
        // Abusive body: stop consuming and let the transport answer with a
        // structured INVALID_ARGUMENT + Connection: close BEFORE the socket
        // is destroyed, so the client sees a real response, not a reset.
        settled = true;
        req.pause();
        const error = new ConnectorError('INVALID_ARGUMENT');
        error.excessiveBody = true;
        reject(error);
      }
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (received > limit) {
        reject(new ConnectorError('INVALID_ARGUMENT'));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on('error', () => fail(new ConnectorError('INVALID_ARGUMENT')));
    req.on('aborted', () => fail(new ConnectorError('INVALID_ARGUMENT')));
  });
}

export function parseJsonBody(buffer) {
  if (buffer.length === 0) throw new ConnectorError('INVALID_ARGUMENT');
  let value;
  try {
    value = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new ConnectorError('INVALID_ARGUMENT');
  }
  return value;
}
