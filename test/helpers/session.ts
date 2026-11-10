// Who the mocked Clerk says is signed in. See test/setup.ts.
export const session: { userId: string | null } = { userId: null }

export function signInAs(userId: string) {
  session.userId = userId
}

export function signOut() {
  session.userId = null
}
