
import Tools from '../agent/localFiles/tools.json'

export type Property = {
    type: string
    description: string
}

export type Parameters = {
    type: string
    properties: Record<string, Property>
    required: string[]
}


export type Function = {
    name: string,
    description: string
    parameters: Parameters
}

export type Tool = {
    type: string
    function: Function
}




export type Message = {
    role: string,
    content: string
}

export type ChatRequest = {
    model: string,
    messages: Message[],
    stream: boolean,
    tools?: Tool[],
    options?: {
        temperature: number,
        top_p: number,
        repeat_penalty: number
    }
}

export type ChatResponse = {
    message: {
        content: string,
    }
}

export type CondinateToolsTyes = {
    ToolName: string,
    Embedding: number[]
}

export type ExtracteToolsType = {
    functionName: string,
    confidence: number,
    parameters: any
}

export type ToolHandlerType = {
    functionName: string,
    handler: (params: any) => Promise<any>|AsyncGenerator<any,any,any>;
}


export type ContextInfo = {
    operation: string;
    result: Record<string, string>;
    parameters: Record<string, string>;
    status: "success" | "fault",
    domain?: string
}

export type RequestResult = {
    toolName: string;
    continuePrompt: string;
}

export type ExecuteToolResultType={
    isGenerator: boolean;
    generator?: AsyncGenerator<any, any, any>;
    result?: RequestResult;
}

export type GeneratorDataType={
    data:any,
    type:"selection",
    label:string
}
export type FunctionCallResultType = {
    result: "error" | "success" | "cancelled"|"confirm_required",
    message: string,
    prompt: string,
    continuePrompt: string | undefined,
    toolName: string,
    lastsegment: boolean,
    isSpecial: boolean,
    isGenerator?:boolean,
    data?:GeneratorDataType,
    list: any[],
    source?:"telegram"|"web"|"whatsapp"
}

export type EmbeddingToolType = {
    tool_name: string;
    embedding_text: string;
    domain_name: string
}
export type EmbeddingDomainTool = {
    domain_name: string;
    embedding_text: string
}

export type RunFinalStepType = {
    subIntent: string,
    selectedToolName: string,
    selectedTool: { functionName: string; parameters: any },
    submission: { Id: string },
    req: any,
    files: string[],
    sessionId: string,
    isLastSegment: boolean

}

export interface PendingAction {
        subIntent: string,
        selectedToolName: string,
        selectedTool?: { functionName: string; parameters: any },
        submission: { Id: string },
        req: any,
        files: string[],
        sessionId: string,
        isLastSegment: boolean
        remainingSegments: string[], 
        resumeIndex:number,                
        controller:AbortController
}

export type PendingGeneratorType={
    toolName: string;
    subIntent: string;
    sessionId: string;
    submissionId: string;
    selectedTool: { functionName: string; parameters: any };
    req: any;
    files: string[];
    resumeIndex: number;
    remainingSegments: string[];
}

export enum MonitoredChatType {
  GROUP = 'group',
  CHANNEL = 'channel',
}

// NEW: هر رکورد می‌تونه منبع (ازش پیام می‌خونیم)، مقصد (بهش پیام
// پردازش‌شده می‌فرستیم)، یا هر دو باشه. این باعث می‌شه هم منابع (گروه‌های
// بار) و هم مقصدها (گروه/کانال‌هایی که خروجی رو می‌فرستیم) در یه جدول
// واحد و با یه فرم افزودن یکسان (لینک) مدیریت بشن.
export enum MonitoredChannelRole {
  SOURCE = 'source',
  DESTINATION = 'destination',
  BOTH = 'both',
}
/**
 * وضعیت عضویت برنامه در گروه/کانال -- با هر تغییر، رویداد
 * channel.membership.changed برای ثبت‌کننده‌ها منتشر می‌شه.
 *   queued  -- ثبت شده، هنوز برای عضویت اقدام نشده
 *   pending -- درخواست عضویت فرستاده شده و منتظر تایید ادمینه
 *   joined  -- عضو شد و پیام‌هاش خونده می‌شه
 *   failed  -- عضویت ممکن نشد (لینک نامعتبر/منقضی، رد درخواست، بن و ...)
 *   removed -- ربات از گروه حذف شد
 */
export enum ChannelMembershipStatus {
  QUEUED = 'queued',
  PENDING = 'pending',
  JOINED = 'joined',
  FAILED = 'failed',
  REMOVED = 'removed',
}
