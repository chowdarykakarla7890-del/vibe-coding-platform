import { FOUNDATION_DSA_IDS, foundationDSAActivity, isFoundationDSAId, type FoundationDSAId } from './dsa-foundations'
import { EXTENDED_DSA_IDS, extendedDSAActivity, isExtendedDSAId, type ExtendedDSAId } from './dsa-extended'

export type TrustedDSAId = FoundationDSAId | ExtendedDSAId
export const TRUSTED_DSA_IDS: readonly TrustedDSAId[] = [...FOUNDATION_DSA_IDS, ...EXTENDED_DSA_IDS]
export function isTrustedDSAId(id: string): id is TrustedDSAId { return isFoundationDSAId(id) || isExtendedDSAId(id) }
export function trustedDSAActivity(id: TrustedDSAId) { return isFoundationDSAId(id) ? foundationDSAActivity(id) : extendedDSAActivity(id) }
