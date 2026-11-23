// Who the mocked Clerk says is signed in, and which Clerk Billing plans they
// hold. See test/setup.ts.
export const session: { userId: string | null; plans: string[] } = {
  userId: null,
  plans: [],
}

export function signInAs(userId: string, plans: string[] = []) {
  session.userId = userId
  session.plans = plans
}

export function signOut() {
  session.userId = null
  session.plans = []
}
