const Client = require("@triton-one/yellowstone-grpc").default;

async function test() {
  console.log("Testing Alchemy gRPC...");
  const endpoint = "https://solana-mainnet.g.alchemy.com";
  // The token from the user's screenshot
  const token = "alch_4KJnlOakjxYuwKhfoQ_LH";
  
  try {
    const client = new Client(endpoint, token, undefined);
    
    // Test subscribe
    const stream = await client.subscribe();
    
    stream.on('data', (data) => {
      console.log("Data:", data);
    });
    
    stream.on('error', (err) => {
      console.error("Stream Error:", err);
      process.exit(1);
    });

    const req = {
      slots: {},
      accounts: {},
      transactions: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [],
      commitment: 0,
    };
    req.ping = { id: 1 };

    stream.write(req);
    
    console.log("Stream opened and ping sent.");
    setTimeout(() => {
        stream.end();
        console.log("Success!");
        process.exit(0);
    }, 2000);
    
  } catch (err) {
    console.error("Failed to connect:", err);
  }
}

test();
