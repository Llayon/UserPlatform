import app from "./app.js";

const port = parseInt(process.env.PORT ?? "3002", 10);
app.listen(port, () => {
  console.log(`[user-platform-api] listening on ${port}`);
});
