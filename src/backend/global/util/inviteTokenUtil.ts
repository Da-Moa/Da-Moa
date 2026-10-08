import { nanoid, urlAlphabet } from 'nanoid';

// Keep the length and alphabet compatible with previously issued invite links.
export const INVITE_TOKEN_LENGTH = 43;
const inviteTokenCharacters = new Set(urlAlphabet);

export function createInviteToken(): string {
  return nanoid(INVITE_TOKEN_LENGTH);
}

export function isInviteToken(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== INVITE_TOKEN_LENGTH)
    return false;
  for (const character of value) {
    if (!inviteTokenCharacters.has(character)) return false;
  }
  return true;
}
