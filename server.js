import express from "express";

const app = express();
const PORT = 3000;

app.use(express.json());

app.post("/", (req, res) => {
  const { amount, token } = req.body;

  res.json({ ok: true, received: req.body });
});

app.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
});
