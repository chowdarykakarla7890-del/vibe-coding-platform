import { CHALLENGE_KINDS, trustedChallengeActivity } from './contracts'
import { reactChallenges } from './react'

// Keep existing IDs and track order. Each language track has three challenges.
export const CHALLENGE_ACTIVITIES=[
  ...CHALLENGE_KINDS.map(kind=>trustedChallengeActivity(`challenge-javascript-${kind}`)),
  ...CHALLENGE_KINDS.map(kind=>trustedChallengeActivity(`challenge-typescript-${kind}`)),
  ...reactChallenges,
  ...CHALLENGE_KINDS.map(kind=>trustedChallengeActivity(`challenge-python-${kind}`)),
  ...CHALLENGE_KINDS.map(kind=>trustedChallengeActivity(`challenge-java-${kind}`)),
  ...CHALLENGE_KINDS.map(kind=>trustedChallengeActivity(`challenge-cpp-${kind}`)),
]
