import type {
  GroupDto,
  GroupMemberDto,
  GroupSummaryDto
} from '../../common/agoraDtos'

type Identified = { id: string }

const mergeById = <TItem extends Identified>(current: TItem[], incoming: TItem[]) => {
  const incomingIds = new Set(incoming.map(({ id }) => id))

  return [
    ...current.filter(({ id }) => !incomingIds.has(id)),
    ...incoming
  ]
}

export const prependById = <TItem extends Identified>(current: TItem[], item: TItem) => [
  item,
  ...current.filter(({ id }) => id !== item.id)
]

export const appendPageById = <TItem extends Identified>(current: TItem[], page: TItem[]) => (
  mergeById(current, page)
)

export const removeById = <TItem extends Identified>(current: TItem[], id: string) => (
  current.filter((item) => item.id !== id)
)

export const summarizeGroup = (group: GroupDto): GroupSummaryDto => ({
  ...group,
  unreadCount: 0
})

export const upsertMember = (members: GroupMemberDto[], member: GroupMemberDto) => (
  [member, ...members.filter(({ principal }) => principal.id !== member.principal.id)]
)

export const appendMemberPage = (members: GroupMemberDto[], page: GroupMemberDto[]) => {
  const pageIds = new Set(page.map(({ principal }) => principal.id))

  return [
    ...members.filter(({ principal }) => !pageIds.has(principal.id)),
    ...page
  ]
}

export const removeMemberByPrincipalId = (members: GroupMemberDto[], principalId: string) => (
  members.filter(({ principal }) => principal.id !== principalId)
)
