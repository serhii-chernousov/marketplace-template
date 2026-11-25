// Budget and CI identity outlive the submitted teardown run (the run itself
// authenticates as this role), so they carry their own Project value and are
// not counted as leftovers by the tag-based emptiness check.
export const GUARD_TAGS = { Project: 'nodejs-pro-hw31-guard' }
