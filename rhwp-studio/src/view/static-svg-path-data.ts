const STATIC_SVG_PATH_COMMAND_ARITY: Readonly<Record<string, number>> = {
  A: 7,
  C: 6,
  H: 1,
  L: 2,
  M: 2,
  Q: 4,
  S: 4,
  T: 2,
  V: 1,
};
const STATIC_SVG_PATH_NUMBER = /[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?/y;

export function isStaticSvgPathDataValid(pathData: string): boolean {
  let index = skipStaticSvgPathWhitespace(pathData, 0);
  let command: string | null = null;
  let sawMove = false;

  while (index < pathData.length) {
    const candidate = pathData[index];
    if (/[A-Za-z]/.test(candidate)) {
      if (!/[AaCcHhLlMmQqSsTtVvZz]/.test(candidate)) {
        return false;
      }
      command = candidate;
      index += 1;
      if (!sawMove) {
        if (command !== 'M' && command !== 'm') {
          return false;
        }
        sawMove = true;
      }
      if (command === 'Z' || command === 'z') {
        command = null;
        index = skipStaticSvgPathWhitespace(pathData, index);
        continue;
      }
    } else if (command === null) {
      return false;
    }

    const normalizedCommand = command.toUpperCase();
    const arity = STATIC_SVG_PATH_COMMAND_ARITY[normalizedCommand];
    if (!arity) {
      return false;
    }
    let groupCount = 0;

    while (index < pathData.length) {
      for (let parameterIndex = 0; parameterIndex < arity; parameterIndex += 1) {
        index = skipStaticSvgPathWhitespace(pathData, index);
        if (pathData[index] === ',') {
          if (groupCount === 0 && parameterIndex === 0) {
            return false;
          }
          index = skipStaticSvgPathWhitespace(pathData, index + 1);
        }
        if (index >= pathData.length || /[A-Za-z]/.test(pathData[index])) {
          return false;
        }

        let value: number;
        if (normalizedCommand === 'A' && (parameterIndex === 3 || parameterIndex === 4)) {
          const flag = pathData[index];
          if (flag !== '0' && flag !== '1') {
            return false;
          }
          value = Number(flag);
          index += 1;
        } else {
          STATIC_SVG_PATH_NUMBER.lastIndex = index;
          const match = STATIC_SVG_PATH_NUMBER.exec(pathData);
          if (!match) {
            return false;
          }
          value = Number(match[0]);
          index = STATIC_SVG_PATH_NUMBER.lastIndex;
        }
        if (!Number.isFinite(value)) {
          return false;
        }
        if (normalizedCommand === 'A' && parameterIndex < 2 && value < 0) {
          return false;
        }
      }
      groupCount += 1;

      index = skipStaticSvgPathWhitespace(pathData, index);
      if (index >= pathData.length || /[AaCcHhLlMmQqSsTtVvZz]/.test(pathData[index])) {
        break;
      }
      if (pathData[index] === ',') {
        index = skipStaticSvgPathWhitespace(pathData, index + 1);
        if (index >= pathData.length || /[A-Za-z]/.test(pathData[index])) {
          return false;
        }
      } else if (/[A-Za-z]/.test(pathData[index])) {
        return false;
      }
    }

    if (groupCount === 0) {
      return false;
    }
  }

  return sawMove;
}

function skipStaticSvgPathWhitespace(pathData: string, start: number): number {
  let index = start;
  while (index < pathData.length && /[\t\n\f\r ]/.test(pathData[index])) {
    index += 1;
  }
  return index;
}
