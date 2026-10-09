import { MAX_GROUP_MEMBERS } from '../../../../../shared/domain/group/constants';
import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';

@ApiSchema({ name: 'GroupMemberPreview' })
export class GroupMemberPreview {
  @ApiProperty({ type: 'string', format: 'uuid' })
  userId!: string;
  @ApiProperty({ type: 'string' })
  displayName!: string;
  @ApiProperty({
    type: 'string',
    format: 'uri',
    nullable: true,
    description:
      '활성 회원의 최신 카카오 프로필 이미지 URL. 탈퇴했거나 이미지가 없으면 null.',
  })
  profileImageUrl!: string | null;
}
@ApiSchema({ name: 'GroupInvite' })
export class GroupInvite {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id!: string;
  @ApiProperty({
    type: 'integer',
    format: 'int64',
    description: 'UTC epoch seconds',
  })
  expiresAt!: number;
}
@ApiSchema({ name: 'Group' })
export class GroupSummary {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id!: string;
  @ApiProperty({
    type: 'string',
    format: 'uuid',
    description: '모임 생성자 ID. 초대와 모임 관리를 담당합니다.',
  })
  creatorId!: string;
  @ApiProperty({ type: 'string' })
  name!: string;
  @ApiProperty({
    type: 'integer',
    format: 'int64',
    description: 'UTC epoch seconds',
  })
  createdAt!: number;
}
@ApiSchema({ name: 'GroupMember' })
export class GroupMember {
  @ApiProperty({ type: 'string', format: 'uuid' })
  userId!: string;
  @ApiProperty({ type: 'string' })
  displayName!: string;
  @ApiProperty({
    type: 'integer',
    format: 'int64',
    description: 'UTC epoch seconds',
    nullable: true,
  })
  excludedAt!: number | null;
}
@ApiSchema({ name: 'GroupListItem' })
export class GroupListItem extends GroupSummary {
  @ApiProperty({ type: 'integer', minimum: 1, maximum: MAX_GROUP_MEMBERS })
  memberCount!: number;
  @ApiProperty({ type: [GroupMemberPreview], maxItems: 5 })
  memberPreview!: GroupMemberPreview[];
}
@ApiSchema({ name: 'GroupDetail' })
export class GroupDetail extends GroupSummary {
  @ApiProperty({
    type: [GroupMember],
    maxItems: MAX_GROUP_MEMBERS,
    description: '활성 멤버만 포함하며 생성자가 첫 번째입니다.',
  })
  members!: GroupMember[];
  @ApiProperty({
    type: 'boolean',
    description: '조회 사용자가 현재 활성 모임 생성자인지 여부',
  })
  isCreator!: boolean;
  @ApiProperty({ type: [GroupInvite] })
  invites!: GroupInvite[];
}
@ApiSchema({ name: 'GroupPage' })
export class GroupPage {
  @ApiProperty({ type: [GroupListItem] })
  items!: GroupListItem[];
  @ApiProperty({ type: 'string', nullable: true })
  nextCursor!: string | null;
}
@ApiSchema({ name: 'InvitePreview' })
export class InvitePreview {
  @ApiProperty({ type: 'string', format: 'uuid' })
  groupId!: string;
  @ApiProperty({ type: 'string' })
  groupName!: string;
  @ApiProperty({ type: 'boolean' })
  isMember!: boolean;
  @ApiProperty({
    type: 'integer',
    format: 'int64',
    description: 'UTC epoch seconds',
  })
  expiresAt!: number;
}
@ApiSchema({ name: 'GroupMutationResult' })
export class GroupMutationResult {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id!: string;
  @ApiPropertyOptional({ type: 'string', format: 'uuid' })
  inviteId?: string;
  @ApiPropertyOptional({ type: 'boolean' })
  linkUnavailable?: boolean;
  @ApiPropertyOptional({
    type: 'string',
    description:
      '초대 최초 발급에서만 /invites/{token} 경로를 반환하며 재시도 기록에는 저장하지 않음',
  })
  sharePath?: string;
}

export { MAX_GROUP_MEMBERS } from '../../../../../shared/domain/group/constants';
export type {
  CreateGroupRequestDTO,
  CreateInviteRequestDTO,
} from '../req/group.request.dto';
