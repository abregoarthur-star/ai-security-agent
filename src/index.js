import { createApp } from './app.js';
import { startSchedule } from './cron.js';

const PORT = process.env.PORT || 3100;

createApp().listen(PORT, () => {
  console.log(`[ai-sec-agent] listening on :${PORT}`);
  startSchedule();
});
