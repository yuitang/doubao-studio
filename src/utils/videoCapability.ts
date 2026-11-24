/**
 * src/utils/videoCapability.ts
 * 视频能力预检纯函数 — 不依赖 DOM/React/Electron 运行时
 *
 * 职责：
 * 1. 在提交视频任务前，基于本地已知状态判断是否允许提交
 * 2. 对 11–15 秒配置，仅在页面出现明确会员限制证据时阻断（2026-11 起免费账号可生成 15 秒）
 * 3. 提供建议配置，但绝不自动替换用户配置
 *
 * 合规约束：
 * - 不得尝试绕过、伪造或规避会员/权益/风控校验
 * - 会员资格不能仅凭本地推断为"可用"，未能确认时保持 unknown
 * - 任何降级必须由用户明确确认
 */

import type {
  VideoModel,
  VideoDuration,
  VideoAspectRatio,
  Account,
  TaskErrorCode,
} from '../types';
import { getVideoQuotaRemaining, getVideoQuotaUsageUnits } from './videoQuota';

// ==================== 类型定义 ====================

/** 能力预检结果状态 */
export type VideoCapabilityState = 'allowed' | 'blocked' | 'unknown';

/** 结构化原因码 */
export type VideoCapabilityIssueCode =
  | 'quota_exhausted'
  | 'login_expired'
  | 'verification_required'
  | 'scheduling_paused'
  | 'cooldown_active'
  | 'membership_required'
  | 'account_error';

/** 能力预检问题项 */
export interface VideoCapabilityIssue {
  code: VideoCapabilityIssueCode;
  message: string;
  /** 是否阻止提交 */
  blocking: boolean;
}

/** 能力预检输入 */
export interface VideoCapabilityInput {
  /** 当前视频模型 */
  model: VideoModel;
  /** 视频时长 */
  duration: VideoDuration;
  /** 画面比例（当前未作为限制因素，保留用于未来扩展） */
  aspectRatio: VideoAspectRatio;
  /** 是否启用手动 15 秒补丁 */
  manual15sEnabled: boolean;
  /** 页面实时观察结果；出现 membership_required 时阻断 11–15 秒提交，unknown 放行 */
  platformAvailability?: 'selectable' | 'membership_required' | 'unknown';
  /** 账号本地额度状态（来自 Account.seedanceQuota） */
  seedanceQuota?: Account['seedanceQuota'];
  /** 账号健康状态（来自 Account.health） */
  health?: Account['health'];
  /** 账号调度配置（来自 Account.scheduling） */
  scheduling?: Account['scheduling'];
  /** 账号状态（来自 Account.status） */
  accountStatus: Account['status'];
  /** 当前时间戳，默认 Date.now()，测试时可注入 */
  now?: number;
}

/** 建议配置（仅作为建议，不改变原始 videoConfig） */
export interface SuggestedVideoConfig {
  model: VideoModel;
  duration: VideoDuration;
  reason: string;
}

/** 能力预检结果 */
export interface VideoCapabilityResult {
  /** 预检状态 */
  state: VideoCapabilityState;
  /** 结构化问题列表 */
  issues: VideoCapabilityIssue[];
  /** 面向用户的中文提示 */
  userMessage: string;
  /** 是否允许提交自动化任务 */
  canSubmit: boolean;
  /** 可选的建议配置，不得自动替换原配置 */
  suggestion?: SuggestedVideoConfig;
}

// ==================== 核心逻辑 ====================

/**
 * 评估视频能力预检。
 *
 * 判断顺序（短路）：
 * 1. 账号状态异常 → blocked
 * 2. 登录失效 → blocked
 * 3. 等待验证 → blocked
 * 4. 调度暂停 → blocked
 * 5. 冷却中 → blocked
 * 6. 额度耗尽 → blocked
 * 7. 11–15 秒出现页面会员窗口证据 → blocked（unknown 不再阻断）
 * 8. 其他情况 → allowed
 *
 * 2026-11 更新：豆包已向免费账号开放 11–15 秒视频生成，本地不再要求
 * "页面实时可选证据"才能提交；只有页面明确弹出会员限制时才 fail-closed。
 */
export function evaluateVideoCapability(input: VideoCapabilityInput): VideoCapabilityResult {
  const now = input.now ?? Date.now();
  const issues: VideoCapabilityIssue[] = [];

  // ---- 1. 账号状态异常 ----
  if (input.accountStatus === 'error') {
    issues.push({
      code: 'account_error',
      message: '账号状态异常，请检查账号健康状态后重试',
      blocking: true,
    });
  }

  // ---- 2. 登录失效 ----
  if (input.health?.loginState === 'expired') {
    issues.push({
      code: 'login_expired',
      message: '账号登录已失效，请重新登录豆包账号',
      blocking: true,
    });
  }

  // ---- 3. 等待验证 ----
  if (input.health?.verificationRequired) {
    issues.push({
      code: 'verification_required',
      message: '账号需要完成人工验证后才能继续执行',
      blocking: true,
    });
  }

  // ---- 4. 调度暂停 ----
  if (input.scheduling?.enabled === false) {
    issues.push({
      code: 'scheduling_paused',
      message: '账号调度已暂停，请在账号管理中启用后重试',
      blocking: true,
    });
  }

  // ---- 5. 冷却中 ----
  const cooldownUntil = input.health?.cooldownUntil;
  if (cooldownUntil && new Date(cooldownUntil).getTime() > now) {
    const remaining = Math.ceil((new Date(cooldownUntil).getTime() - now) / 60000);
    issues.push({
      code: 'cooldown_active',
      message: `账号处于冷却中，约 ${remaining} 分钟后恢复`,
      blocking: true,
    });
  }

  // 手动冷却
  const manualCooldown = input.scheduling?.manualCooldownUntil;
  if (manualCooldown && new Date(manualCooldown).getTime() > now) {
    const remaining = Math.ceil((new Date(manualCooldown).getTime() - now) / 60000);
    issues.push({
      code: 'cooldown_active',
      message: `账号手动冷却中，约 ${remaining} 分钟后恢复`,
      blocking: true,
    });
  }

  // ---- 6. 额度耗尽 ----
  const requiredUnits = getVideoQuotaUsageUnits(input.duration);
  const remainingUnits = getVideoQuotaRemaining(input.seedanceQuota);
  if (input.seedanceQuota?.exhausted || remainingUnits < requiredUnits) {
    issues.push({
      code: 'quota_exhausted',
      message: input.seedanceQuota?.exhausted
        ? '账号当日视频额度已耗尽，请明日再试或更换账号'
        : `账号当日视频额度不足：本任务需 ${requiredUnits} 单位，当前剩余 ${remainingUnits} 单位`,
      blocking: true,
    });
  }

  // ---- 7. 11–15 秒会员窗口门禁 ----
  // 2026-11 起豆包免费账号也可生成 11–15 秒视频，不再要求页面实时可选证据。
  // 仅当页面出现明确的会员限制证据时才阻断，unknown 保持放行。
  const durationSeconds = Number.parseInt(input.duration, 10);
  const isLongDuration = durationSeconds >= 11;
  const membershipBlocked = isLongDuration && input.platformAvailability === 'membership_required';
  if (membershipBlocked) {
    issues.push({
      code: 'membership_required',
      message: '当前页面要求会员操作，已停止提交',
      blocking: true,
    });
  }

  // ---- 确定最终状态 ----
  const blockingIssues = issues.filter((i) => i.blocking);

  if (blockingIssues.length > 0) {
    // 有阻塞性问题
    const state: VideoCapabilityState = 'blocked';
    const userMessage = blockingIssues.map((i) => i.message).join('；');
    return {
      state,
      issues,
      userMessage,
      canSubmit: false,
      // 提供建议配置（仅作为建议）：仅在会员窗口导致阻断时建议降回 10 秒
      suggestion: membershipBlocked
        ? {
            model: input.model,
            duration: '10s',
            reason: '当前页面出现会员限制；10 秒兼容性更好，是否调整由用户决定',
          }
        : undefined,
    };
  }

  // 无阻塞、无风险
  return {
    state: 'allowed',
    issues,
    userMessage: '',
    canSubmit: true,
  };
}

/**
 * 根据当前配置生成建议配置。
 * 仅作为建议返回，不改变原始 videoConfig。
 */
export function suggestCompatibleVideoConfig(
  model: VideoModel,
  duration: VideoDuration,
): SuggestedVideoConfig | undefined {
  // 2026-11 起免费账号可生成 11–15 秒，不再默认建议降回 10 秒。
  return undefined;
}

/**
 * 判断错误码是否属于"限制类失败"——即不应扣减额度、应立即终止轮询。
 *
 * 限制类失败包括：
 * - membership_required: 会员限制
 * - quota_exhausted: 额度耗尽
 * - face_restricted: 真人脸限制
 * - content_rejected: 内容审核拒绝
 *
 * 这些情况下任务未成功生成视频，不应扣减 Seedance 额度。
 */
export function isRestrictionFailure(errorCode: string): boolean {
  const restrictionCodes: TaskErrorCode[] = [
    'membership_required',
    'quota_exhausted',
    'face_restricted',
    'content_rejected',
  ];
  return restrictionCodes.includes(errorCode as TaskErrorCode);
}

/**
 * 判断错误码是否应立即终止视频产物轮询。
 *
 * 这些错误意味着继续等待不会有结果：
 * - membership_required: 会员限制，不会生成
 * - quota_exhausted: 额度耗尽，不会生成
 * - face_restricted: 真人脸限制，不会生成
 * - content_rejected: 内容审核拒绝，不会生成
 * - generation_failed: 平台明确生成失败
 */
export function shouldStopVideoPolling(errorCode: string): boolean {
  const stopCodes: TaskErrorCode[] = [
    'membership_required',
    'quota_exhausted',
    'face_restricted',
    'content_rejected',
    'generation_failed',
  ];
  return stopCodes.includes(errorCode as TaskErrorCode);
}
