import { z } from 'zod'
import { stableScheduleUuid } from '../setup'

// The scheduler validates schedule ids with zod's strict uuid check (version + variant nibbles), so a
// derived schedule id must be a *valid* RFC-4122 uuid, not merely a uuid-shaped hex string.
const uuidSchema = z.string().uuid()

describe('stableScheduleUuid', () => {
  const keys = [
    'push_notifications:reclaim-stuck:00000000-0000-0000-0000-000000000001',
    'push_notifications:reclaim-stuck:ffffffff-ffff-ffff-ffff-ffffffffffff',
    'push_notifications:reclaim-stuck:tenant-abc',
    'a',
    '',
  ]

  it('produces a valid RFC-4122 uuid for any key (forced version + variant)', () => {
    for (const key of keys) {
      const id = stableScheduleUuid(key)
      expect(uuidSchema.safeParse(id).success).toBe(true)
      // version nibble is 5 (name-based), variant nibble is one of 8/9/a/b.
      expect(id[14]).toBe('5')
      expect(['8', '9', 'a', 'b']).toContain(id[19])
    }
  })

  it('is deterministic (idempotent upsert key) and collision-distinct per input', () => {
    expect(stableScheduleUuid(keys[0])).toBe(stableScheduleUuid(keys[0]))
    expect(stableScheduleUuid(keys[0])).not.toBe(stableScheduleUuid(keys[1]))
  })
})
