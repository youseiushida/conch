import * as os from "os";
import { Conch } from "../src/conch";

async function main() {
  console.log("--- Conch Demo Start ---");

  // 1. Launch (Backend + Session)
  const shell = os.platform() === "win32" ? "powershell.exe" : "bash";
  console.log(`> Using shell: ${shell}`);

  const conch = await Conch.launch({
    cols: 80,
    rows: 24,
    backend: {
      type: "localPty",
      file: shell,
      args: [],
      env: process.env,
    },
  });
  
  // Wait for initial prompt
  console.log("> Waiting for initial prompt (stable)...");
  await conch.waitForStable({ durationMs: 500 });

  // 4. Scenario: Hello World
  console.log("\n--- Scenario 1: Hello World ---");
  const helloCmd = 'echo "Hello Conch"';
  console.log(`> Executing: ${helloCmd}`);
  
  conch.execute(helloCmd);
  
  console.log("> Waiting for output...");
  await conch.waitForText("Hello Conch");
  console.log('✅ "Hello Conch" detected!');

  // 5. Scenario: Interactive (Input Simulation)
  console.log("\n--- Scenario 2: Interactive Input ---");
  // Just typing something to see it echoed
  const textToType = "This is typed by Conch";
  console.log(`> Typing: "${textToType}"`);
  
  conch.type(textToType);
  
  // Wait for echo
  await conch.waitForText(textToType);
  console.log("✅ Typed text detected in output!");

  // Clear line with Ctrl+C
  console.log("> Pressing Ctrl+C");
  conch.press("Ctrl+C");
  await conch.waitForStable({ durationMs: 300 });

  // 6. Inspect Snapshot
  console.log("\n--- Final Snapshot ---");
  const snapshot = conch.getSnapshot();
  console.log("----------------------------------------");
  console.log(snapshot.text);
  console.log("----------------------------------------");
  console.log(`Cursor: (${snapshot.cursorSnapshot.x}, ${snapshot.cursorSnapshot.y})`);

  // Cleanup
  console.log("\n> Cleaning up...");
  conch.dispose();
  console.log("--- Conch Demo Finished ---");
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
