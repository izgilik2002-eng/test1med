const { DeepgramClient } = require("@deepgram/sdk");

async function test() {
    const client = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY });
    const connection = await client.listen.v1.connect({ model: "nova-2", interim_results: true, language: 'ru' });
    
    connection.on("open", () => {
        console.log("Connection opened");
        // Send a dummy audio
        connection.socket.send(Buffer.alloc(1024 * 50)); 
        
        setTimeout(() => {
            console.log("Sending CloseStream JSON to Deepgram...");
            connection.socket.send(JSON.stringify({ type: "CloseStream" }));
        }, 1000);
    });
    
    connection.on("message", (data) => {
        console.log("Received from Deepgram:", data.type, "is_final:", data.is_final);
        if (data.type === 'Results' && data.channel?.alternatives[0]?.transcript) {
            console.log("Transcript:", data.channel.alternatives[0].transcript);
        }
    });

    connection.on("close", () => {
        console.log("Deepgram closed gracefully.");
        process.exit(0);
    });
    
    connection.connect();
}

test();
