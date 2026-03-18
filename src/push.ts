import webpush from "web-push";

export function initWebPush() {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
    throw new Error("VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT are required");
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  icon?: string;
  badge?: string;
  image?: string;
  actions?: { action: string; title: string; url?: string }[];
}

export async function sendToSubscription(
  subscription: { endpoint: string; p256dh: string; auth: string },
  payload: PushPayload
): Promise<{ success: boolean; expired?: boolean; errorStatus?: number; errorBody?: string }> {
  try {
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      JSON.stringify(payload)
    );
    return { success: true };
  } catch (err: any) {
    const status: number = err.statusCode ?? err.status ?? 0;
    const body: string = err.body ?? err.message ?? String(err);
    console.error(`[push] sendNotification failed — status=${status} endpoint=…${subscription.endpoint.slice(-20)} body=${body}`);
    // 404/410 = subscription is expired/unsubscribed
    if (status === 404 || status === 410) {
      return { success: false, expired: true, errorStatus: status, errorBody: body };
    }
    return { success: false, errorStatus: status, errorBody: body };
  }
}
