const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Fúria Mods IA — servidor funcionando!");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    project: "furia-mods-ia",
    version: "1.0.0"
  });
});

app.listen(PORT, () => {
  console.log(`Fúria Mods IA rodando na porta ${PORT}`);
});
