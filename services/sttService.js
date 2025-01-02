import axios from 'axios';

const STT_ENDPOINT = process.env.STT_API_ENDPOINT;
const STT_API_KEY = process.env.STT_API_KEY;

export async function voiceToText(audioBuffer) {
  // Real integration with STT service:
  // e.g. send audioBuffer as multipart/form-data 
  // For simplicity assume audioBuffer is a base64 string or handle as needed
  const resp = await axios.post(STT_ENDPOINT, {
    audio: audioBuffer
  },{
    headers:{ 'Authorization': `Bearer ${STT_API_KEY}` }
  });

  return { transcription: resp.data.transcription };
}
