import { UserRole } from '../generated/prisma/enums';
import { adminRoom, joinsAdminRoom, userRoom } from './rooms';

describe('the rooms', () => {
  it('names a personal room after the user', () => {
    expect(userRoom('user-1')).toBe('user:user-1');
  });

  // Pinned because the docs name this string and a rename that drifted from
  // them would be invisible: nothing errors when two servers disagree about a
  // room name, the events just stop arriving.
  it('names the admin room after the tenant', () => {
    expect(adminRoom('tenant-a')).toBe('tenant:tenant-a:admins');
  });
});

describe('joinsAdminRoom', () => {
  it('says yes to an ADMIN', () => {
    expect(joinsAdminRoom(UserRole.ADMIN)).toBe(true);
  });

  // The assertion that carries the change. An agent in this room would receive
  // every ticket of the company over the socket, including the ones the HTTP
  // layer now answers 404 to — and not one HTTP test would fail.
  it('says no to an AGENT', () => {
    expect(joinsAdminRoom(UserRole.AGENT)).toBe(false);
  });

  it('says no to a REQUESTER', () => {
    expect(joinsAdminRoom(UserRole.REQUESTER)).toBe(false);
  });

  it('says no to the ADMIN_MASTER', () => {
    expect(joinsAdminRoom(UserRole.ADMIN_MASTER)).toBe(false);
  });
});
