import * as os from 'os';
import { ConchSession } from '../src/session';
import { LocalPty } from '../src/backend/LocalPty';
import { waitForText, waitForStable } from '../src/utils';

async function main() {
  console.log('--- Conch Demo Start ---');

  // 1. Setup Backend
  const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
  console.log(`> Using shell: ${shell}`);

  const pty = new LocalPty(shell, [], {
    cols: 80,
    rows: 24,
    env: process.env,
  });

  // 2. Setup Session
  const session = new ConchSession(pty, { cols: 80, rows: 24 });

  // 3. Start Process
  console.log('> Spawning process...');
  await pty.spawn();
  
  // Wait for initial prompt
  console.log('> Waiting for initial prompt (stable)...');
  await waitForStable(session, 500);

  // 4. Scenario: Hello World
  console.log('\n--- Scenario 1: Hello World ---');
  const helloCmd = 'echo "Hello Conch"';
  console.log(`> Executing: ${helloCmd}`);
  
  session.execute(helloCmd);
  
  console.log('> Waiting for output...');
  await waitForText(session, 'Hello Conch');
  console.log('✅ "Hello Conch" detected!');

  // 5. Scenario: Interactive (Input Simulation)
  console.log('\n--- Scenario 2: Interactive Input ---');
  // Just typing something to see it echoed
  const textToType = 'This is typed by Conch';
  console.log(`> Typing: "${textToType}"`);
  
  session.type(textToType);
  
  // Wait for echo
  await waitForText(session, textToType);
  console.log('✅ Typed text detected in output!');

  // Clear line with Ctrl+C
  console.log('> Pressing Ctrl+C');
  session.press('Ctrl+C');
  await waitForStable(session, 300);

  // 6. Inspect Snapshot
  console.log('\n--- Final Snapshot ---');
  const snapshot = session.getSnapshot();
  console.log('----------------------------------------');
  console.log(snapshot.text);
  console.log('----------------------------------------');
  console.log(`Cursor: (${snapshot.cursorSnapshot.x}, ${snapshot.cursorSnapshot.y})`);

  // Cleanup
  console.log('\n> Cleaning up...');
  session.dispose();
  console.log('--- Conch Demo Finished ---');
}

main().catch(err => {
  console.error('Demo failed:', err);
  process.exit(1);
});
