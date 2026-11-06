# Membres et invitations (J10)

Aucun endpoint REST n'est ajouté (la spec n'en liste pas) : les actions passent par des Server Actions et des fonctions SQL appelées avec la session de l'utilisateur.

## Fonctions SQL (RPC, `authenticated` uniquement)
| Fonction | Rôle requis | Résultat | Erreurs |
|---|---|---|---|
| `create_invitation(p_org, p_email, p_role, p_token_hash)` | owner/admin actif (admin : jamais `company_owner`) | id de l'invitation | `forbidden` (403), `validation_failed` (22023), `already_member` (P0001) |
| `revoke_invitation(p_org, p_invitation_id)` | owner/admin (admin : pas une invitation `company_owner`) | — | `forbidden`, `invitation_invalid` |
| `accept_invitation(p_token_hash)` | tout utilisateur connecté dont l'e-mail confirmé correspond | id de l'organisation | `invitation_invalid` (identique pour toute cause) |
| `transfer_ownership(p_org, p_new_owner)` | `company_owner` | — | `forbidden`, `invalid_target` |

L'identité vient toujours de `auth.uid()`. Le hash est `sha256(jeton)` en hexadécimal minuscule ; le jeton (32 octets, base64url) n'est jamais stocké ni journalisé.

## Server Actions (`apps/web/lib/members/actions.ts`)
`inviteMemberAction` (renvoie le chemin du lien une seule fois), `revokeInvitationAction`, `changeMemberRoleAction`, `removeMemberAction`, `transferOwnershipAction`, `acceptInvitationAction`. Elles renvoient des **codes** (`invalid_input`, `forbidden`, `already_member`, `invitation_invalid`, `last_owner`, `generic`), jamais de messages.

## Page d'acceptation
`/{locale}/invite/{token}` : en-têtes `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `X-Robots-Tag: noindex`. `Referrer-Policy: no-referrer` aussi sur `/{locale}/login` et `/{locale}/signup` (le jeton peut transiter dans `next=`).
