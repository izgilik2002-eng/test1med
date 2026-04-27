const { DeepgramClient } = require("@deepgram/sdk");

async function test() {
    const client = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY });
    const connection = await client.listen.v1.connect({ model: "nova-2", interim_results: true });
    
    connection.on("open", () => {
        console.log("Connection opened");
        console.log("connection keys:", Object.keys(connection));
        console.log("typeof connection.send:", typeof connection.send);
        console.log("typeof connection.socket.send:", typeof connection.socket.send);
        connection.socket.close();
    });
    connection.connect();
}

test();
