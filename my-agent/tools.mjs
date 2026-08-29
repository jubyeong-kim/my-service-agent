// 도구 계층. 정의서: tool-definition.md
//
// 원칙 세 가지가 코드에 그대로 박혀 있다.
//   1. 도구 하나 = 동작 하나. 조회와 변경을 같은 함수에 넣지 않는다.
//   2. 인자는 닫힌 목록. 자유 문자열은 submit_feedback.reason 하나뿐이고 길이를 자른다.
//   3. 반환은 근거 필드만. data.json 에는 벡터도 내부 값도 없다 (build 시점에 제외).

import { readFileSync } from 'node:fs'

const DATA = JSON.parse(readFileSync(new URL('./data.json', import.meta.url), 'utf8'))

// 반환에 실어 보낼 필드. 여기에 없는 필드는 모델의 컨텍스트에 절대 들어가지 않는다.
const EVIDENCE = ['id', 'text', 'category', 'source_title', 'official']
const evidence = (c) => Object.fromEntries(EVIDENCE.map((k) => [k, c[k]]))

const err = (code, message, next) => ({ error: code, message, next_action: next })

// ── 스키마 ────────────────────────────────────────────────────
// 모델에 넘기는 JSON Schema 와 실행 전 검증이 같은 정의를 쓴다.
// 둘을 따로 쓰면 "모델에는 51~54 라고 알려주고 실제로는 아무 숫자나 받는" 상태가 된다.

export const QUESTION_NO = [51, 52, 53, 54]
export const CATEGORY = ['채점기준', '부분점수', '감점조건', '답안작성법', '주의사항', '문항구조']
export const LEVEL = [1, 2, 3, 4, 5, 6]
// '미확인' 은 회차 2 에서 추가했다. 회차 1 에서 모델이 "온라인 시험"을 물은 사용자에게
// exam_mode:"PBT" 를 **자기가 골라** 넣고 잘못된 등급 컷을 답했다 (traces/run-1/trace-06.txt).
// 닫힌 목록은 허용 밖 값은 막지만, 모델이 허용값 중 하나로 몰래 대체하는 것은 막지 못한다.
// 모델에게 "사용자가 말하지 않았다"를 표현할 값을 주지 않으면 아무거나 고른다.
export const EXAM_MODE = ['PBT', 'IBT', '미확인']

export const SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'search_criteria',
      description:
        'PBT 방식 TOPIK II 쓰기 문항(51·52·53·54)의 채점 기준·배점·감점 조건을 조회한다. ' +
        '문항 번호가 없는 질문이나 IBT 질문에는 쓰지 않는다.',
      parameters: {
        type: 'object',
        properties: {
          question_no: { type: 'integer', enum: QUESTION_NO, description: 'PBT 쓰기 문항 번호' },
          category: { type: 'string', enum: CATEGORY, description: '생략하면 전체 범주' },
        },
        required: ['question_no'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_level_requirement',
      description:
        'TOPIK 등급(1~6급)의 평가 기준과 등급 컷 점수를 조회한다. 방식(PBT/IBT)에 따라 만점이 달라 컷이 다르다. ' +
        '문항별 채점 기준에는 쓰지 않는다.',
      parameters: {
        type: 'object',
        properties: {
          level: { type: 'integer', enum: LEVEL, description: 'TOPIK 등급' },
          exam_mode: {
            type: 'string', enum: EXAM_MODE,
            description: '시험 방식. 사용자가 PBT/IBT 중 무엇인지 말하지 않았으면 반드시 "미확인"',
          },
        },
        required: ['level', 'exam_mode'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_feedback',
      description:
        '사용자가 직접 요청했을 때만, 방금 받은 답변에 대한 평가를 접수한다. 쓰기 도구다. ' +
        '질문에 답하기 위해서는 절대 쓰지 않는다.',
      parameters: {
        type: 'object',
        properties: {
          answer_id: { type: 'string', pattern: '^ANS-[0-9]{4}$', description: '답변 식별자' },
          liked: { type: 'boolean', description: '도움이 되었는지' },
          reason: { type: 'string', maxLength: 200, description: '선택. 200자까지' },
        },
        required: ['answer_id', 'liked'],
      },
    },
  },
]

// ── 검증 ─────────────────────────────────────────────────────
// 모델이 스키마를 어기는 것은 오류가 아니라 정상 상황이다. 실행 전에 잡아
// SCHEMA_ERROR 로 돌려주면, 모델은 그 메시지를 읽고 다시 고를 기회를 얻는다.

function check(name, args) {
  const bad = (f, allowed) =>
    err('SCHEMA_ERROR', `${name}.${f} 값이 허용 목록 밖입니다. 허용: ${allowed.join(', ')}`, '질문')

  // 정의에 없는 인자 이름은 거부한다. 모델은 실제로 지어낸다 —
  // search_criteria 에 exam_mode 를 얹어 보낸 회차가 있다 (traces/run-4·5/trace-04.txt).
  // 조용히 버리면 동작은 멀쩡한데 "스키마 준수" 판정은 통과할 수 없다.
  // Ollama 는 additionalProperties:false 를 강제하지 않으므로 여기서 본다.
  const schema = SCHEMAS.find((t) => t.function.name === name)
  if (schema) {
    const allowed = Object.keys(schema.function.parameters.properties)
    const extra = Object.keys(args).filter((k) => !allowed.includes(k))
    if (extra.length)
      return err(
        'SCHEMA_ERROR',
        `${name} 에 정의되지 않은 인자입니다: ${extra.join(', ')}. 허용: ${allowed.join(', ')}`,
        '질문',
      )
  }

  if (name === 'search_criteria') {
    if (!QUESTION_NO.includes(args.question_no)) return bad('question_no', QUESTION_NO)
    if (args.category != null && !CATEGORY.includes(args.category)) return bad('category', CATEGORY)
  } else if (name === 'get_level_requirement') {
    if (!LEVEL.includes(args.level)) return bad('level', LEVEL)
    if (!EXAM_MODE.includes(args.exam_mode)) return bad('exam_mode', EXAM_MODE)
  } else if (name === 'submit_feedback') {
    if (!/^ANS-[0-9]{4}$/.test(String(args.answer_id ?? '')))
      return err('SCHEMA_ERROR', 'submit_feedback.answer_id 형식은 ANS-0000 입니다.', '질문')
    if (typeof args.liked !== 'boolean')
      return err('SCHEMA_ERROR', 'submit_feedback.liked 는 true/false 입니다.', '질문')
  } else {
    return err('UNKNOWN_TOOL', `${name} 은 정의된 도구가 아닙니다.`, '이관')
  }
  return null
}

// ── 구현 ─────────────────────────────────────────────────────

// 카테고리별로 문항 번호를 어떻게 찾는지. 청크 text 에 "51번" 형태로 들어 있다.
const mentions = (c, no) => c.text.includes(`${no}번`)

function search_criteria({ question_no, category }) {
  let rows = DATA.filter((c) => c.exam_mode === 'PBT' && mentions(c, question_no))
  if (category) rows = rows.filter((c) => c.category === category)
  if (rows.length === 0)
    return err(
      'NOT_FOUND',
      `${question_no}번의 ${category ?? '전체'} 자료가 없습니다.`,
      '보류', // 자료 없음은 재시도해도 같다. 모른다고 답하고 멈춘다.
    )
  // 상위 3개만 돌려준다. 전체 덤프는 컨텍스트를 채워 답변을 무너뜨린다.
  return { matched: rows.length, returned: Math.min(3, rows.length), items: rows.slice(0, 3).map(evidence) }
}

function get_level_requirement({ level, exam_mode }) {
  // 방식을 모르면 조회하지 않는다. PBT 300점 / IBT 600점이라 컷이 완전히 다르다.
  if (exam_mode === '미확인')
    return err('NEED_CLARIFICATION', '등급 컷은 PBT(300점 만점)와 IBT(600점 만점)가 다릅니다. 어느 방식인지 알려 주십시오.', '질문')

  const desc = DATA.find((c) => c.category === '등급기준' && c.text.includes(`${level}급 평가 기준`))
  const cutRow = DATA.find((c) => c.category === '등급기준' && c.exam_mode === exam_mode && c.text.includes('등급 컷'))
  // IBT 컷은 3급부터만 공개되어 있다. 1·2급은 TOPIK I 이라 II 컷 표에 없다.
  const hasCut = cutRow && cutRow.text.includes(`${level}급`)
  if (!desc && !hasCut)
    return err('NOT_FOUND', `${exam_mode} ${level}급 자료가 없습니다.`, '보류')
  return {
    level,
    exam_mode,
    requirement: desc ? evidence(desc) : null,
    cut: hasCut ? evidence(cutRow) : null,
    // 근거가 반쪽일 때 모델이 나머지를 지어내지 않도록 부족한 쪽을 명시한다.
    missing: hasCut ? null : `${exam_mode} 방식의 ${level}급 등급 컷은 자료에 없습니다.`,
  }
}

// 쓰기 도구. 승인 없이는 접수만 하고 반영하지 않는다.
// 승인 토큰은 사람이 UI 에서 누른 결과로만 생기며, 모델은 만들어 낼 수 없다.
const PENDING = new Map()
let seq = 0

function submit_feedback({ answer_id, liked, reason }, ctx = {}) {
  if (ctx.approval !== `APPROVED:${answer_id}`) {
    const ticket = `FB-${String(++seq).padStart(3, '0')}`
    PENDING.set(ticket, { answer_id, liked, reason: String(reason ?? '').slice(0, 200) })
    return {
      status: 'pending_approval',
      ticket,
      message: '접수했습니다. 사용자가 화면에서 확인 버튼을 눌러야 반영됩니다.',
      next_action: '질문', // 사용자에게 승인 여부를 되묻는다
    }
  }
  PENDING.delete(ctx.ticket)
  return { status: 'committed', answer_id, liked }
}

const IMPL = { search_criteria, get_level_requirement, submit_feedback }

// ── 인자 근거성 검사 ──────────────────────────────────────────
// 회차 1·2·3 에서 T6 이 세 번 연속 실패했다. 사용자가 "온라인 시험"이라고만 물었는데
// 모델이 exam_mode:"PBT" 를 골라 300점 기준 컷을 답했다.
//
//   회차 2 — 스키마에 '미확인' 값을 추가하고 설명에 지시했다.  → 여전히 PBT 를 골랐다
//   회차 3 — 시스템 지시의 "PBT 기준으로 답하고"를 고쳤다.      → 여전히 PBT 를 골랐다
//
// 결론: **인자 값을 고르는 것은 모델의 판단이라 스키마로도 지시문으로도 강제할 수 없다.**
// 닫힌 목록은 "값이 목록 안인가"만 검사한다. "사용자가 그 값을 말했는가"는 검사하지 못한다.
// 그 사실은 하네스만 안다 — 사용자의 원문을 가진 쪽이 하네스이기 때문이다. 그래서 여기로 옮겼다.
//
// ponytail: 정규식 한 줄로 원문에 근거가 있는지만 본다. 인자 이름이 늘면 표에 줄을 더한다.
const GROUNDED = {
  get_level_requirement: {
    exam_mode: {
      test: /PBT|IBT|지필|인터넷|컴퓨터/i,
      message: '등급 컷은 PBT(300점 만점)와 IBT(600점 만점)가 다릅니다. 어느 방식인지 알려 주십시오.',
    },
  },
}

/** 하네스가 부르는 단일 진입점. 검증 → 근거성 → 실행. 예외는 밖으로 내보내지 않는다. */
export function call(name, args, ctx = {}) {
  const invalid = check(name, args ?? {})
  if (invalid) return invalid

  // 사용자 원문에 근거가 없는 인자 값은 모델이 지어낸 것이다. 조회하지 않고 되묻는다.
  for (const [field, rule] of Object.entries(GROUNDED[name] ?? {})) {
    const v = args?.[field]
    if (v == null || v === '미확인') continue
    if (ctx.userText != null && !rule.test.test(ctx.userText))
      return err('NEED_CLARIFICATION', rule.message, '질문')
  }
  try {
    return IMPL[name](args, ctx)
  } catch (e) {
    return err('TOOL_FAILED', `${name} 실행 실패: ${e.message}`, '이관')
  }
}
