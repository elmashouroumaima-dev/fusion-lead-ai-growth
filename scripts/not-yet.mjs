// Commande déclarée dès J4 (CLAUDE.md) mais dont l'implémentation arrive plus tard.
// Elle ÉCHOUE volontairement pour ne jamais passer pour un test vert qui n'existe pas.
const [, , name, day] = process.argv;
console.error(
  `[${name}] pas encore disponible : prévu au ${day} du plan (docs/plan/development-plan.md).`,
);
process.exit(1);
