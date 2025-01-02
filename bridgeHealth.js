import axios from 'axios';

// Replace with your actual bridge URL and port
const BRIDGE_URL = "http://<your-bridge-host>:29318"; // Example: http://localhost:29318

async function testWhatsAppBridge() {
    try {
        const response = await axios.get(`${BRIDGE_URL}/health`);
        if (response.status === 200) {
            console.log("WhatsApp bridge is running and reachable!");
            console.log("Response:", response.data);
        } else {
            console.log("Unexpected response from the bridge:", response.status);
        }
    } catch (error) {
        console.error("Failed to connect to the WhatsApp bridge.");
        console.error("Error message:", error.message);
        if (error.response) {
            console.error("Response data:", error.response.data);
        }
    }
}

testWhatsAppBridge();

