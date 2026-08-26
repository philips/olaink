# Ola Ink account and username policy

An Ola Ink username is a public delivery address, separate from the private
AuthGravity authentication subject and Ola Ink's opaque `account_*` routing ID.

- A signed-in account can claim exactly one normalized username.
- A username is permanent: it cannot be renamed, transferred, released, or
  reused by another account.
- Closing an account retires its username. Ola Ink retains the minimum routing
  tombstone needed to prevent reassignment; it does not make the address
  resolvable or deliverable.
- Support must not alter an assignment. An exceptional replacement requires a
  new account and a different available username.

This tombstone is an account-erasure exception that needs privacy/legal review
before an account-deletion feature ships. Production backup and restore
procedures must preserve `account_usernames`; restoring a database without it
can break the no-reuse promise.
