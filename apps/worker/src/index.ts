import { WORKER_NAME } from "./info";

// Squelette J4 : la boucle de claim des jobs arrive au J13 (ADR 003). Aucune logique métier ici.
console.info(`[${WORKER_NAME}] démarrage du squelette (aucun job traité avant J13).`);
