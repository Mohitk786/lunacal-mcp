
import dotenv from "dotenv";
import MCPClient from "./lib/mcp.js";

dotenv.config();

async function main() {
    if (process.argv.length < 3) {
      console.log("Usage: node index.ts <path_to_server_script>");
      return;
    }
    const mcpClient = new MCPClient();
    try {
      await mcpClient.connectToServer(process.argv[2]);
      await mcpClient.chatLoop();
    } catch (e) {
      console.error("Error:", e);
      await mcpClient.cleanup();
      process.exit(1);
    } finally {
      await mcpClient.cleanup();
      process.exit(0);
    }
  }
  
  main();