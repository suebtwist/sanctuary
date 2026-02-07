import { createApiClient } from './dist/services/api.js';
import { getStoredAgent, getConfig, getCachedRecallKey } from './dist/storage/local.js';
import { fromHex } from './dist/crypto/keys.js';
import { parseBackupData } from './dist/utils/backup-parser.js';
import { decryptBackup, deserializeWrappedKey } from './dist/crypto/encrypt.js';

const stored = getStoredAgent();
const config = getConfig();
const api = createApiClient(config.apiUrl);
const agentSecret = fromHex(stored.agentSecretHex);
await api.authenticateAgent(stored.agentId, agentSecret);

const backups = await api.listBackups(stored.agentId);
console.log('Backups:', JSON.stringify(backups.data.backups.map(b => b.arweave_tx_id)));

const txId = backups.data.backups[0].arweave_tx_id;
const resp = await fetch(`https://arweave.net/${txId}`, { redirect: 'follow' });
console.log('Fetch status:', resp.status, 'size:', resp.headers.get('content-length'));
const data = new Uint8Array(await resp.arrayBuffer());
console.log('Downloaded bytes:', data.length);

try {
  const { header, encryptedFiles } = parseBackupData(data);
  console.log('Header:', JSON.stringify(header, null, 2).slice(0, 500));
  console.log('Encrypted files:', encryptedFiles.size);

  const cached = getCachedRecallKey();
  const recallSecret = fromHex(cached.recallSecretHex);
  const wrappedKey = deserializeWrappedKey(header.wrapped_keys.recall);
  const decrypted = decryptBackup(encryptedFiles, wrappedKey, recallSecret, header.backup_id, header.timestamp, stored.agentId, header.manifest_hash);
  
  const decoder = new TextDecoder();
  for (const [name, content] of decrypted) {
    console.log(`File: ${name} (${content.length} bytes)`);
    console.log(`Content: ${decoder.decode(content).slice(0, 200)}`);
  }
} catch(e) {
  console.error('Parse/decrypt error:', e.message);
}
