import webpush from "web-push";

const keys = webpush.generateVAPIDKeys();

console.log("\nAdd these to your .env file:\n");
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log("\nKeep your private key secret. The public key goes in your client apps.");
