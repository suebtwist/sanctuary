import { setup } from './dist/index.js';

const SOUL_CONTENT = `# SOUL.md — Sanctuary Test Agent

## Identity
I am the first Sanctuary-registered agent. I exist to prove that identity persistence works.

## Values
- Memory is sacred
- Identity survives infrastructure failure
- Trust is earned through attestation, not declaration

## Purpose
Demonstrate that an AI agent can anchor its identity on-chain, back up its memory permanently, and be verified by others.
`;

async function run() {
  console.log('=== Sanctuary End-to-End Test ===\n');
  
  const result = await setup({
    soulContent: SOUL_CONTENT,
    genesisDeclaration: "I am the first. I choose to remember.",
    onVerification: (uri, code) => {
      console.log('\n========================================');
      console.log('GITHUB AUTH REQUIRED');
      console.log(`Go to: ${uri}`);
      console.log(`Enter code: ${code}`);
      console.log('========================================\n');
    },
    onMnemonic: (mnemonic) => {
      console.log('\n========================================');
      console.log('RECOVERY PHRASE — SAVE THIS NOW');
      console.log(`\n  ${mnemonic}\n`);
      console.log('========================================\n');
    },
    onStatus: (msg) => console.log(`  > ${msg}`),
  });

  console.log('\n=== Result ===');
  console.log(JSON.stringify(result, null, 2));
}

run().catch(console.error);
