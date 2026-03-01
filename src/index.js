import { runTxdotScan } from './scanEngine.js';

(async () => {
  console.log('Starting TxDOT statewide letting scan...');
  try {
    await runTxdotScan();
    console.log('Scan finished successfully.');
    process.exit(0);
  } catch (err) {
    console.error('Scan failed:', err);
    process.exit(1);
  }
})();
