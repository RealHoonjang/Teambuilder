// 전역 상태
let students = [];
let viewMode = 'upload'; // 'upload' | 'teacher' | 'student'
let numTeams = 4;
let mode = 'random'; // 'random' | 'balanced' | 'gender_balanced' | 'manual'
let teams = [];
let selectedStudent = null;
let selectedStudentIndex = null;
let showFinalTeams = false;
let anonymizedStudents = [];
/** 학생용 기록 표시: 'line' 연속 데이터(꺾은선), 'radar' 독립 항목(레이더) */
let studentRecordChartType = 'line';
let studentRecordChartInstances = [];
/** 학생용 화면에서 성별 표시 여부 (이름은 항상 숨김) */
let showStudentGender = false;

// 엑셀 파일 파싱
function parseExcelFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const jsonData = XLSX.utils.sheet_to_json(worksheet, {
          header: 1,
          defval: '',
          raw: true,
        });
        const normalizedData = jsonData.map((row) => [...row]);

        // 병합된 셀 값을 펼쳐서 헤더/데이터 탐지 정확도를 높임
        const merges = worksheet['!merges'] || [];
        merges.forEach((merge) => {
          const startRow = merge.s.r;
          const endRow = merge.e.r;
          const startCol = merge.s.c;
          const endCol = merge.e.c;
          const topLeftValue = (normalizedData[startRow] || [])[startCol];
          if (topLeftValue === '' || topLeftValue === undefined || topLeftValue === null) return;

          for (let r = startRow; r <= endRow; r++) {
            if (!normalizedData[r]) normalizedData[r] = [];
            for (let c = startCol; c <= endCol; c++) {
              if (normalizedData[r][c] === '' || normalizedData[r][c] === undefined || normalizedData[r][c] === null) {
                normalizedData[r][c] = topLeftValue;
              }
            }
          }
        });
        
        if (normalizedData.length < 2) {
          reject(new Error('엑셀 파일에 데이터가 충분하지 않습니다.'));
          return;
        }

        const toText = (value) => String(value ?? '').trim();
        const isNameHeader = (value) => {
          const text = toText(value).toLowerCase();
          return text.includes('이름') || text.includes('성명') || text.includes('name');
        };
        const isGenderHeader = (value) => {
          const text = toText(value).toLowerCase();
          return text.includes('성별') || text === 'gender' || text === 'sex';
        };
        const normalizeGender = (value) => {
          const text = toText(value).toLowerCase();
          if (!text) return null;
          if (text.includes('남') || text === 'm' || text === 'male') return '남';
          if (text.includes('여') || text === 'f' || text === 'female') return '여';
          return null;
        };
        const isNumericLike = (value) => {
          if (value === '' || value === null || value === undefined) return false;
          if (typeof value === 'number') return Number.isFinite(value);
          return !Number.isNaN(Number(value));
        };

        // 병합/제목 행이 있을 수 있으므로 상단 여러 행에서 실제 헤더 행을 탐색
        const scanRowLimit = Math.min(15, normalizedData.length);
        const maxColCount = normalizedData.reduce((max, row) => Math.max(max, row.length), 0);
        let bestHeader = null;

        for (let rowIndex = 0; rowIndex < scanRowLimit; rowIndex++) {
          const row = normalizedData[rowIndex] || [];
          for (let colIndex = 0; colIndex < maxColCount; colIndex++) {
            if (!isNameHeader(row[colIndex])) continue;

            const candidateRecordCols = [];
            for (let c = colIndex + 1; c < maxColCount; c++) {
              let numericCount = 0;
              const sampleEnd = Math.min(normalizedData.length, rowIndex + 31);
              for (let r = rowIndex + 1; r < sampleEnd; r++) {
                const sampleValue = (normalizedData[r] || [])[c];
                if (isNumericLike(sampleValue)) numericCount++;
              }
              // 우연한 숫자(학번 등) 잡음을 줄이기 위해 최소 2건 이상 숫자 존재 시 기록 열로 채택
              if (numericCount >= 2) candidateRecordCols.push(c);
            }

            let genderColumnIndex = -1;
            for (let c = 0; c <= colIndex; c++) {
              if (isGenderHeader(row[c])) {
                genderColumnIndex = c;
                break;
              }
            }

            if (!bestHeader || candidateRecordCols.length > bestHeader.recordColumnIndices.length) {
              bestHeader = {
                headerRowIndex: rowIndex,
                nameColumnIndex: colIndex,
                recordColumnIndices: candidateRecordCols,
                genderColumnIndex,
              };
            }
          }
        }

        if (!bestHeader || bestHeader.nameColumnIndex === -1) {
          reject(new Error('이름 열을 찾을 수 없습니다. 헤더에 "이름" 또는 "성명"이 포함되어야 합니다.'));
          return;
        }

        const { headerRowIndex, nameColumnIndex, recordColumnIndices, genderColumnIndex } = bestHeader;

        if (recordColumnIndices.length === 0) {
          reject(new Error('숫자 기록 열을 찾을 수 없습니다.'));
          return;
        }

        // 헤더 아래에서 실제 데이터 시작 행 탐색 (병합된 추가 헤더/공백행 건너뜀)
        let dataStartRowIndex = headerRowIndex + 1;
        for (let i = headerRowIndex + 1; i < normalizedData.length; i++) {
          const row = normalizedData[i] || [];
          const name = toText(row[nameColumnIndex]);
          const hasRecord = recordColumnIndices.some((idx) => isNumericLike(row[idx]));
          const lowerName = name.toLowerCase();
          const looksLikeHeaderAgain =
            lowerName.includes('이름') ||
            lowerName.includes('성명') ||
            lowerName.includes('name');
          if (name && hasRecord && !looksLikeHeaderAgain) {
            dataStartRowIndex = i;
            break;
          }
        }

        const parsedStudents = [];
        for (let i = dataStartRowIndex; i < normalizedData.length; i++) {
          const row = normalizedData[i];
          if (!row || !row[nameColumnIndex]) continue;
          
          const name = toText(row[nameColumnIndex]);
          const lowerName = name.toLowerCase();
          if (!name || lowerName.includes('이름') || lowerName.includes('성명') || lowerName.includes('name')) continue;
          
          const records = [];
          recordColumnIndices.forEach(index => {
            const value = row[index];
            if (value !== undefined && value !== null && value !== '') {
              const numValue = typeof value === 'number' ? value : Number(value);
              if (!isNaN(numValue)) {
                records.push(numValue);
              }
            }
          });
          
          if (records.length > 0) {
            const gender = genderColumnIndex >= 0 ? normalizeGender(row[genderColumnIndex]) : null;
            parsedStudents.push({ name, records, gender });
          }
        }
        
        if (parsedStudents.length === 0) {
          reject(new Error('학생 데이터를 찾을 수 없습니다.'));
          return;
        }
        
        resolve(parsedStudents);
      } catch (error) {
        reject(error);
      }
    };
    
    reader.onerror = () => {
      reject(new Error('파일을 읽는 중 오류가 발생했습니다.'));
    };
    
    reader.readAsArrayBuffer(file);
  });
}

// 팀 편성 알고리즘
function formRandomTeams(students, numTeams) {
  if (numTeams < 1 || students.length === 0) return [];
  
  const shuffled = [...students];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  
  const teams = Array.from({ length: numTeams }, (_, i) => ({
    id: i + 1,
    members: [],
  }));
  
  const baseSize = Math.floor(shuffled.length / numTeams);
  const remainder = shuffled.length % numTeams;
  
  let currentIndex = 0;
  for (let i = 0; i < numTeams; i++) {
    const teamSize = baseSize + (i < remainder ? 1 : 0);
    teams[i].members = shuffled.slice(currentIndex, currentIndex + teamSize);
    currentIndex += teamSize;
  }
  
  teams.forEach(team => {
    if (team.members.length > 0 && team.members[0].records.length > 0) {
      const allRecords = team.members.flatMap(s => s.records);
      team.averageRecord = allRecords.reduce((sum, r) => sum + r, 0) / allRecords.length;
    }
  });
  
  return teams;
}

/** n개 중 k개 조합(인덱스 배열). k===0이면 [[]] 하나 */
function combinationsOfSize(n, k) {
  if (k === 0) return [[]];
  if (k > n) return [];
  const out = [];
  const path = [];
  function dfs(from) {
    if (path.length === k) {
      out.push([...path]);
      return;
    }
    const need = k - path.length;
    for (let i = from; i <= n - need; i++) {
      path.push(i);
      dfs(i + 1);
      path.pop();
    }
  }
  dfs(0);
  return out;
}

/**
 * 정원 상한 targetSizes 하에서 그리디 배정. spread 최소, 동률 시 인원 적은 팀 우선.
 * 반환 전 team.averageRecord 계산.
 */
function assignBalancedTeamsGreedy(studentsWithStats, numTeams, targetSizes) {
  const teams = Array.from({ length: numTeams }, (_, i) => ({
    id: i + 1,
    members: [],
    averageRecord: 0,
  }));

  const teamRecordSum = new Array(numTeams).fill(0);
  const teamRecordCount = new Array(numTeams).fill(0);

  studentsWithStats.forEach((student) => {
    const eligible = [];
    for (let i = 0; i < numTeams; i++) {
      if (teams[i].members.length < targetSizes[i]) eligible.push(i);
    }

    let bestTeam = eligible[0];
    let bestSpread = Infinity;

    for (const j of eligible) {
      const sums = teamRecordSum.slice();
      const counts = teamRecordCount.slice();
      sums[j] += student.recordSum;
      counts[j] += student.recordCount;

      const avgs = [];
      for (let t = 0; t < numTeams; t++) {
        if (counts[t] > 0) avgs.push(sums[t] / counts[t]);
      }
      const spread = avgs.length === 0 ? 0 : Math.max(...avgs) - Math.min(...avgs);

      if (spread < bestSpread) {
        bestSpread = spread;
        bestTeam = j;
      } else if (spread === bestSpread) {
        const curBest = teams[bestTeam].members.length;
        const curJ = teams[j].members.length;
        if (curJ < curBest || (curJ === curBest && j < bestTeam)) {
          bestTeam = j;
        }
      }
    }

    teams[bestTeam].members.push({
      name: student.name,
      records: student.records,
      gender: student.gender || null,
    });
    teamRecordSum[bestTeam] += student.recordSum;
    teamRecordCount[bestTeam] += student.recordCount;
  });

  teams.forEach((team) => {
    if (team.members.length > 0 && team.members[0].records.length > 0) {
      const allRecords = team.members.flatMap((s) => s.records);
      team.averageRecord = allRecords.reduce((sum, r) => sum + r, 0) / allRecords.length;
    }
  });

  return teams;
}

/** 편차·공정성(평균 높은 팀은 인원 적게) 기준으로 결과 비교: 음수면 a가 더 좋음 */
function compareBalancedOutcomes(teamsA, teamsB) {
  const stats = (teams) => {
    const avgs = teams.map((t) => t.averageRecord || 0);
    const sizes = teams.map((t) => t.members.length);
    const maxAvg = Math.max(...avgs);
    const minAvg = Math.min(...avgs);
    const minSz = Math.min(...sizes);
    const maxSz = Math.max(...sizes);
    const spread = maxAvg - minAvg;
    const eps = 1e-9;
    const hiIdx = avgs.map((a, i) => (a >= maxAvg - eps ? i : -1)).filter((i) => i >= 0);
    const loIdx = avgs.map((a, i) => (a <= minAvg + eps ? i : -1)).filter((i) => i >= 0);
    /** 최고 평균 팀이 가장 적은 인원이 아니면 불이익 */
    const hiOversize = Math.max(...hiIdx.map((i) => sizes[i] - minSz));
    /** 최저 평균 팀이 가장 많은 인원이 아니면 불이익 */
    const loUndersize = Math.max(...loIdx.map((i) => maxSz - sizes[i]));
    return { spread, hiOversize, loUndersize };
  };
  const a = stats(teamsA);
  const b = stats(teamsB);
  if (a.spread !== b.spread) return a.spread - b.spread;
  if (a.hiOversize !== b.hiOversize) return a.hiOversize - b.hiOversize;
  if (a.loUndersize !== b.loUndersize) return a.loUndersize - b.loUndersize;
  return 0;
}

function cloneTeams(teams) {
  return teams.map((team) => ({
    ...team,
    members: team.members.map((m) => ({ ...m, records: [...(m.records || [])], gender: m.gender || null })),
  }));
}

function computeObjective(teams) {
  const avgs = teams.map((t) => t.averageRecord || 0);
  const sizes = teams.map((t) => t.members.length);
  const maxAvg = Math.max(...avgs);
  const minAvg = Math.min(...avgs);
  const minSz = Math.min(...sizes);
  const maxSz = Math.max(...sizes);
  const spread = maxAvg - minAvg;
  const eps = 1e-9;
  const hiIdx = avgs.map((a, i) => (a >= maxAvg - eps ? i : -1)).filter((i) => i >= 0);
  const loIdx = avgs.map((a, i) => (a <= minAvg + eps ? i : -1)).filter((i) => i >= 0);
  const hiOversize = Math.max(...hiIdx.map((i) => sizes[i] - minSz));
  const loUndersize = Math.max(...loIdx.map((i) => maxSz - sizes[i]));
  return { spread, hiOversize, loUndersize };
}

function compareObjective(a, b) {
  if (a.spread !== b.spread) return a.spread - b.spread;
  if (a.hiOversize !== b.hiOversize) return a.hiOversize - b.hiOversize;
  if (a.loUndersize !== b.loUndersize) return a.loUndersize - b.loUndersize;
  return 0;
}

function shuffleArray(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function buildTeamsFromOrderedStudents(orderedStudents, numTeams, targetSizes) {
  const teams = Array.from({ length: numTeams }, (_, i) => ({
    id: i + 1,
    members: [],
    averageRecord: 0,
  }));

  let index = 0;
  for (let i = 0; i < numTeams; i++) {
    const size = targetSizes[i];
    for (let c = 0; c < size; c++) {
      const s = orderedStudents[index++];
      teams[i].members.push({ name: s.name, records: s.records, gender: s.gender || null });
    }
  }

  teams.forEach((team) => {
    if (team.members.length > 0 && team.members[0].records.length > 0) {
      const allRecords = team.members.flatMap((s) => s.records);
      team.averageRecord = allRecords.reduce((sum, r) => sum + r, 0) / allRecords.length;
    } else {
      team.averageRecord = 0;
    }
  });

  return teams;
}

function hasGenderData(students) {
  return students.some((s) => s.gender === '남' || s.gender === '여');
}

function computeGenderAwareObjective(teams) {
  const avgs = teams.map((t) => t.averageRecord || 0);
  const recordSpread = Math.max(...avgs) - Math.min(...avgs);

  const maleCounts = teams.map((t) => t.members.filter((m) => m.gender === '남').length);
  const femaleCounts = teams.map((t) => t.members.filter((m) => m.gender === '여').length);
  const genderSpread =
    (Math.max(...maleCounts) - Math.min(...maleCounts)) +
    (Math.max(...femaleCounts) - Math.min(...femaleCounts));
  const genderImbalance = teams.reduce((sum, t) => {
    const male = t.members.filter((m) => m.gender === '남').length;
    const female = t.members.filter((m) => m.gender === '여').length;
    return sum + Math.abs(male - female);
  }, 0);

  return { genderSpread, genderImbalance, recordSpread };
}

function compareGenderAwareObjective(a, b) {
  if (a.genderSpread !== b.genderSpread) return a.genderSpread - b.genderSpread;
  if (a.genderImbalance !== b.genderImbalance) return a.genderImbalance - b.genderImbalance;
  if (a.recordSpread !== b.recordSpread) return a.recordSpread - b.recordSpread;
  return 0;
}

function optimizeByPairSwapsWithComparator(initialTeams, objectiveFn, compareFn, maxPasses = 8) {
  const teams = cloneTeams(initialTeams);
  let currentObj = objectiveFn(teams);

  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;

    for (let i = 0; i < teams.length; i++) {
      for (let j = i + 1; j < teams.length; j++) {
        for (let ai = 0; ai < teams[i].members.length; ai++) {
          for (let bi = 0; bi < teams[j].members.length; bi++) {
            const next = cloneTeams(teams);
            const a = next[i].members[ai];
            const b = next[j].members[bi];
            next[i].members[ai] = b;
            next[j].members[bi] = a;

            next.forEach((team) => {
              if (team.members.length > 0 && team.members[0].records.length > 0) {
                const allRecords = team.members.flatMap((s) => s.records);
                team.averageRecord = allRecords.reduce((sum, r) => sum + r, 0) / allRecords.length;
              } else {
                team.averageRecord = 0;
              }
            });

            const nextObj = objectiveFn(next);
            if (compareFn(nextObj, currentObj) < 0) {
              for (let t = 0; t < teams.length; t++) {
                teams[t].members = next[t].members;
                teams[t].averageRecord = next[t].averageRecord;
              }
              currentObj = nextObj;
              improved = true;
            }
          }
        }
      }
    }

    if (!improved) break;
  }

  return teams;
}

function assignGenderBalancedTeamsGreedy(studentsWithStats, numTeams, targetSizes) {
  const teams = Array.from({ length: numTeams }, (_, i) => ({
    id: i + 1,
    members: [],
    averageRecord: 0,
  }));

  const teamRecordSum = new Array(numTeams).fill(0);
  const teamRecordCount = new Array(numTeams).fill(0);
  const maleCounts = new Array(numTeams).fill(0);
  const femaleCounts = new Array(numTeams).fill(0);

  studentsWithStats.forEach((student) => {
    const eligible = [];
    for (let i = 0; i < numTeams; i++) {
      if (teams[i].members.length < targetSizes[i]) eligible.push(i);
    }

    let bestTeam = eligible[0];
    let bestObjective = null;

    for (const j of eligible) {
      const sums = teamRecordSum.slice();
      const counts = teamRecordCount.slice();
      const males = maleCounts.slice();
      const females = femaleCounts.slice();

      sums[j] += student.recordSum;
      counts[j] += student.recordCount;
      if (student.gender === '남') males[j] += 1;
      if (student.gender === '여') females[j] += 1;

      const avgs = [];
      for (let t = 0; t < numTeams; t++) {
        if (counts[t] > 0) avgs.push(sums[t] / counts[t]);
      }
      const recordSpread = avgs.length === 0 ? 0 : Math.max(...avgs) - Math.min(...avgs);
      const genderSpread =
        (Math.max(...males) - Math.min(...males)) +
        (Math.max(...females) - Math.min(...females));
      const genderImbalance = males.reduce((sum, male, idx) => sum + Math.abs(male - females[idx]), 0);

      const candidateObjective = { genderSpread, genderImbalance, recordSpread };
      if (!bestObjective || compareGenderAwareObjective(candidateObjective, bestObjective) < 0) {
        bestObjective = candidateObjective;
        bestTeam = j;
      } else if (compareGenderAwareObjective(candidateObjective, bestObjective) === 0) {
        const curBest = teams[bestTeam].members.length;
        const curJ = teams[j].members.length;
        if (curJ < curBest || (curJ === curBest && j < bestTeam)) bestTeam = j;
      }
    }

    teams[bestTeam].members.push({
      name: student.name,
      records: student.records,
      gender: student.gender || null,
    });
    teamRecordSum[bestTeam] += student.recordSum;
    teamRecordCount[bestTeam] += student.recordCount;
    if (student.gender === '남') maleCounts[bestTeam] += 1;
    if (student.gender === '여') femaleCounts[bestTeam] += 1;
  });

  teams.forEach((team) => {
    if (team.members.length > 0 && team.members[0].records.length > 0) {
      const allRecords = team.members.flatMap((s) => s.records);
      team.averageRecord = allRecords.reduce((sum, r) => sum + r, 0) / allRecords.length;
    } else {
      team.averageRecord = 0;
    }
  });

  return teams;
}

/** 현재 배정에서 팀 간 1:1 스왑을 탐색해 목적함수를 개선 */
function optimizeByPairSwaps(initialTeams, maxPasses = 8) {
  const teams = cloneTeams(initialTeams);
  let currentObj = computeObjective(teams);

  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;

    for (let i = 0; i < teams.length; i++) {
      for (let j = i + 1; j < teams.length; j++) {
        for (let ai = 0; ai < teams[i].members.length; ai++) {
          for (let bi = 0; bi < teams[j].members.length; bi++) {
            const next = cloneTeams(teams);
            const a = next[i].members[ai];
            const b = next[j].members[bi];
            next[i].members[ai] = b;
            next[j].members[bi] = a;

            next.forEach((team) => {
              if (team.members.length > 0 && team.members[0].records.length > 0) {
                const allRecords = team.members.flatMap((s) => s.records);
                team.averageRecord = allRecords.reduce((sum, r) => sum + r, 0) / allRecords.length;
              } else {
                team.averageRecord = 0;
              }
            });

            const nextObj = computeObjective(next);
            if (compareObjective(nextObj, currentObj) < 0) {
              for (let t = 0; t < teams.length; t++) {
                teams[t].members = next[t].members;
                teams[t].averageRecord = next[t].averageRecord;
              }
              currentObj = nextObj;
              improved = true;
            }
          }
        }
      }
    }

    if (!improved) break;
  }

  return teams;
}

function formBalancedTeams(students, numTeams) {
  if (numTeams < 1 || students.length === 0) return [];

  const n = students.length;
  const baseSize = Math.floor(n / numTeams);
  const remainder = n % numTeams;

  const studentsWithStats = students.map((student) => {
    const records = student.records || [];
    const recordSum = records.reduce((sum, r) => sum + r, 0);
    const recordCount = records.length;
    const meanRecord = recordCount > 0 ? recordSum / recordCount : 0;
    return { ...student, recordSum, recordCount, meanRecord };
  });

  studentsWithStats.sort((a, b) => b.meanRecord - a.meanRecord);

  let extraTeamIndexSets = combinationsOfSize(numTeams, remainder);
  const maxComb = 2500;
  if (extraTeamIndexSets.length > maxComb) {
    const step = Math.ceil(extraTeamIndexSets.length / maxComb);
    extraTeamIndexSets = extraTeamIndexSets.filter((_, idx) => idx % step === 0);
  }

  let bestTeams = null;
  for (const extraIndices of extraTeamIndexSets) {
    const extraSet = new Set(extraIndices);
    const targetSizes = Array.from({ length: numTeams }, (_, i) => baseSize + (extraSet.has(i) ? 1 : 0));
    const localCandidates = [];

    // 1) 기존 그리디 시작점
    const greedy = assignBalancedTeamsGreedy(studentsWithStats, numTeams, targetSizes);
    localCandidates.push(optimizeByPairSwaps(greedy));

    // 2) 랜덤 시작점 다중 탐색(경우의 수 근사)
    const randomStartCount = Math.min(80, 15 + studentsWithStats.length);
    for (let r = 0; r < randomStartCount; r++) {
      const randomOrdered = shuffleArray(studentsWithStats);
      const randomSeedTeams = buildTeamsFromOrderedStudents(randomOrdered, numTeams, targetSizes);
      localCandidates.push(optimizeByPairSwaps(randomSeedTeams));
    }

    let bestLocal = localCandidates[0];
    for (let i = 1; i < localCandidates.length; i++) {
      if (compareBalancedOutcomes(localCandidates[i], bestLocal) < 0) {
        bestLocal = localCandidates[i];
      }
    }

    if (!bestTeams || compareBalancedOutcomes(bestLocal, bestTeams) < 0) {
      bestTeams = bestLocal;
    }
  }

  return bestTeams;
}

function formGenderBalancedTeams(students, numTeams) {
  if (numTeams < 1 || students.length === 0) return [];
  if (!hasGenderData(students)) return formBalancedTeams(students, numTeams);

  const n = students.length;
  const baseSize = Math.floor(n / numTeams);
  const remainder = n % numTeams;

  const studentsWithStats = students.map((student) => {
    const records = student.records || [];
    const recordSum = records.reduce((sum, r) => sum + r, 0);
    const recordCount = records.length;
    const meanRecord = recordCount > 0 ? recordSum / recordCount : 0;
    return { ...student, recordSum, recordCount, meanRecord };
  });

  studentsWithStats.sort((a, b) => {
    // 성별을 먼저 섞기 위해 기록 정렬 + 이름 타이브레이크
    if (b.meanRecord !== a.meanRecord) return b.meanRecord - a.meanRecord;
    return String(a.name).localeCompare(String(b.name), 'ko');
  });

  let extraTeamIndexSets = combinationsOfSize(numTeams, remainder);
  const maxComb = 2500;
  if (extraTeamIndexSets.length > maxComb) {
    const step = Math.ceil(extraTeamIndexSets.length / maxComb);
    extraTeamIndexSets = extraTeamIndexSets.filter((_, idx) => idx % step === 0);
  }

  let bestTeams = null;
  for (const extraIndices of extraTeamIndexSets) {
    const extraSet = new Set(extraIndices);
    const targetSizes = Array.from({ length: numTeams }, (_, i) => baseSize + (extraSet.has(i) ? 1 : 0));
    const localCandidates = [];

    const greedy = assignGenderBalancedTeamsGreedy(studentsWithStats, numTeams, targetSizes);
    localCandidates.push(optimizeByPairSwapsWithComparator(greedy, computeGenderAwareObjective, compareGenderAwareObjective));

    const randomStartCount = Math.min(80, 15 + studentsWithStats.length);
    for (let r = 0; r < randomStartCount; r++) {
      const randomOrdered = shuffleArray(studentsWithStats);
      const randomSeedTeams = buildTeamsFromOrderedStudents(randomOrdered, numTeams, targetSizes);
      localCandidates.push(
        optimizeByPairSwapsWithComparator(
          randomSeedTeams,
          computeGenderAwareObjective,
          compareGenderAwareObjective
        )
      );
    }

    let bestLocal = localCandidates[0];
    for (let i = 1; i < localCandidates.length; i++) {
      if (compareGenderAwareObjective(computeGenderAwareObjective(localCandidates[i]), computeGenderAwareObjective(bestLocal)) < 0) {
        bestLocal = localCandidates[i];
      }
    }

    if (
      !bestTeams ||
      compareGenderAwareObjective(computeGenderAwareObjective(bestLocal), computeGenderAwareObjective(bestTeams)) < 0
    ) {
      bestTeams = bestLocal;
    }
  }

  return bestTeams;
}

function initializeManualTeams(students, numTeams) {
  return Array.from({ length: numTeams }, (_, i) => ({
    id: i + 1,
    members: [],
  }));
}

function addStudentToTeam(teams, student, teamId) {
  const updatedTeams = teams.map(team => {
    if (team.id === teamId) {
      const isInOtherTeam = teams.some(t => 
        t.id !== teamId && t.members.some(m => m.name === student.name || (m.id && m.id === student.id))
      );
      
      if (!isInOtherTeam) {
        return {
          ...team,
          members: [...team.members, student],
        };
      }
    }
    return team;
  });
  
  updatedTeams.forEach(team => {
    if (team.members.length > 0 && team.members[0].records.length > 0) {
      const allRecords = team.members.flatMap(s => s.records);
      team.averageRecord = allRecords.reduce((sum, r) => sum + r, 0) / allRecords.length;
    }
  });
  
  return updatedTeams;
}

function removeStudentFromTeam(teams, studentIdentifier, teamId) {
  const updatedTeams = teams.map(team => {
    if (team.id === teamId) {
      return {
        ...team,
        members: team.members.filter(m => {
          if (m.name === studentIdentifier) return false;
          if (m.id === studentIdentifier) return false;
          return true;
        }),
      };
    }
    return team;
  });
  
  updatedTeams.forEach(team => {
    if (team.members.length > 0 && team.members[0].records.length > 0) {
      const allRecords = team.members.flatMap(s => s.records);
      team.averageRecord = allRecords.reduce((sum, r) => sum + r, 0) / allRecords.length;
    } else {
      team.averageRecord = 0;
    }
  });
  
  return updatedTeams;
}

// 엑셀 다운로드 함수
function downloadTeamsToExcel(isStudentView = false) {
  if (teams.length === 0) {
    alert('다운로드할 팀 편성 결과가 없습니다.');
    return;
  }

  const workbook = XLSX.utils.book_new();
  const worksheetData = [];

  // 헤더 행
  const maxRecords = Math.max(...teams.flatMap(team => 
    team.members.map(m => m.records.length)
  ), 0);
  
  const headerRow = ['팀', '이름'];
  for (let i = 1; i <= maxRecords; i++) {
    headerRow.push(`기록${i}`);
  }
  headerRow.push('평균 기록');
  worksheetData.push(headerRow);

  // 각 팀별 데이터
  teams.forEach(team => {
    // 팀 구분선 (빈 행)
    if (worksheetData.length > 1) {
      worksheetData.push([]);
    }

    // 팀 헤더
    const teamHeader = [`팀 ${team.id}`, `(${team.members.length}명)`];
    for (let i = 0; i < maxRecords; i++) {
      teamHeader.push('');
    }
    if (team.averageRecord) {
      teamHeader.push(team.averageRecord.toFixed(1));
    } else {
      teamHeader.push('');
    }
    worksheetData.push(teamHeader);

    // 팀 멤버들
    team.members.forEach(member => {
      // 학생용 뷰에서는 원래 이름을 찾아서 사용
      let memberName = member.name;
      if (isStudentView && member.originalIndex !== undefined) {
        const originalStudent = students[member.originalIndex];
        if (originalStudent) {
          memberName = originalStudent.name;
        }
      }
      
      const row = [`팀 ${team.id}`, memberName];
      
      // 기록 추가 (학생용 뷰에서는 원래 학생의 기록 사용)
      let recordsToUse = member.records;
      if (isStudentView && member.originalIndex !== undefined) {
        const originalStudent = students[member.originalIndex];
        if (originalStudent) {
          recordsToUse = originalStudent.records;
        }
      }
      
      for (let i = 0; i < maxRecords; i++) {
        if (i < recordsToUse.length) {
          row.push(recordsToUse[i]);
        } else {
          row.push('');
        }
      }
      
      // 평균 기록 계산
      if (recordsToUse.length > 0) {
        const avg = recordsToUse.reduce((sum, r) => sum + r, 0) / recordsToUse.length;
        row.push(avg.toFixed(1));
      } else {
        row.push('');
      }
      
      worksheetData.push(row);
    });
  });

  // 미배정 학생 추가 (교사용 뷰에서만)
  if (!isStudentView) {
    const assignedNames = new Set(teams.flatMap(team => team.members.map(m => m.name)));
    const unassigned = students.filter(s => !assignedNames.has(s.name));
    
    if (unassigned.length > 0) {
      worksheetData.push([]);
      worksheetData.push(['미배정 학생', '', ...Array(maxRecords).fill(''), '']);
      unassigned.forEach(student => {
        const row = ['', student.name];
        for (let i = 0; i < maxRecords; i++) {
          if (i < student.records.length) {
            row.push(student.records[i]);
          } else {
            row.push('');
          }
        }
        if (student.records.length > 0) {
          const avg = student.records.reduce((sum, r) => sum + r, 0) / student.records.length;
          row.push(avg.toFixed(1));
        } else {
          row.push('');
        }
        worksheetData.push(row);
      });
    }
  }

  // 워크시트 생성
  const worksheet = XLSX.utils.aoa_to_sheet(worksheetData);
  
  // 열 너비 설정
  const colWidths = [
    { wch: 8 },  // 팀
    { wch: 15 }, // 이름
  ];
  for (let i = 0; i < maxRecords; i++) {
    colWidths.push({ wch: 10 }); // 기록들
  }
  colWidths.push({ wch: 12 }); // 평균 기록
  worksheet['!cols'] = colWidths;

  // 워크북에 시트 추가
  XLSX.utils.book_append_sheet(workbook, worksheet, '팀 편성 결과');

  // 파일명 생성
  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const filename = `팀편성결과_${dateStr}.xlsx`;

  // 다운로드
  XLSX.writeFile(workbook, filename);
}

// UI 렌더링 함수들
function showError(message) {
  const errorDiv = document.getElementById('error-message');
  errorDiv.textContent = message;
  errorDiv.classList.remove('hidden');
}

function hideError() {
  const errorDiv = document.getElementById('error-message');
  errorDiv.classList.add('hidden');
}

function renderMainView() {
  document.getElementById('upload-view').classList.add('hidden');
  document.getElementById('main-view').classList.remove('hidden');
  document.getElementById('student-count').textContent = `${students.length}명`;
  
  if (viewMode === 'teacher') {
    renderTeacherView();
  } else {
    renderStudentView();
  }
}

function renderTeacherView() {
  document.getElementById('teacher-view').classList.remove('hidden');
  document.getElementById('student-view').classList.add('hidden');
  const enableGenderMode = hasGenderData(students);
  if (!enableGenderMode && mode === 'gender_balanced') {
    mode = 'balanced';
  }
  
  const container = document.getElementById('teacher-view');
  container.innerHTML = `
    <div class="w-full max-w-6xl mx-auto space-y-6">
      <div class="bg-white p-6 rounded-lg shadow-md">
        <h2 class="text-2xl font-bold mb-4">팀 편성 설정</h2>
        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-2">팀 수</label>
            <input type="number" id="num-teams-input" min="1" max="${students.length}" value="${numTeams}" 
              class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-2">편성 방식</label>
            <div class="space-y-2">
              <label class="flex items-center">
                <input type="radio" name="mode" value="random" ${mode === 'random' ? 'checked' : ''} class="mr-2">
                <span>랜덤 편성 (균등한 인원 분배)</span>
              </label>
              <label class="flex items-center">
                <input type="radio" name="mode" value="balanced" ${mode === 'balanced' ? 'checked' : ''} class="mr-2">
                <span>${enableGenderMode ? '밸런스 편성(성별 무작위)' : '밸런스 편성(인원·기록 밸런스)'}</span>
              </label>
              ${enableGenderMode ? `
                <label class="flex items-center">
                  <input type="radio" name="mode" value="gender_balanced" ${mode === 'gender_balanced' ? 'checked' : ''} class="mr-2">
                  <span>밸런스 편성(성별까지 고려)</span>
                </label>
              ` : ''}
              <label class="flex items-center">
                <input type="radio" name="mode" value="manual" ${mode === 'manual' ? 'checked' : ''} class="mr-2">
                <span>수동 편성(교사가 직접 조정)</span>
              </label>
            </div>
          </div>
          <button id="form-teams-btn" class="w-full bg-blue-600 text-white py-3 px-4 rounded-lg hover:bg-blue-700 transition-colors font-medium text-lg shadow-md">
            팀 편성하기
          </button>
          ${teams.length > 0 ? `
            <button id="reset-teams-btn" class="w-full bg-gray-500 text-white py-2 px-4 rounded-lg hover:bg-gray-600 transition-colors font-medium mt-2">
              편성 초기화
            </button>
          ` : ''}
        </div>
      </div>
      ${teams.length > 0 ? renderTeams() : ''}
    </div>
  `;
  
  // 이벤트 리스너
  document.getElementById('num-teams-input').addEventListener('input', (e) => {
    numTeams = Number(e.target.value);
  });
  
  document.querySelectorAll('input[name="mode"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      mode = e.target.value;
    });
  });
  
  document.getElementById('form-teams-btn').addEventListener('click', handleFormTeams);
  if (teams.length > 0) {
    document.getElementById('reset-teams-btn').addEventListener('click', () => {
      teams = [];
      renderTeacherView();
    });
  }
  
  if (teams.length > 0) {
    attachTeamEventListeners();
  }
}

function renderTeams() {
  const getUnassignedStudents = () => {
    const assignedNames = new Set(teams.flatMap(team => team.members.map(m => m.name)));
    return students.filter(s => !assignedNames.has(s.name));
  };
  const showGenderInfo = mode === 'gender_balanced';
  const getGenderCounts = (team) => {
    const male = team.members.filter((m) => m.gender === '남').length;
    const female = team.members.filter((m) => m.gender === '여').length;
    return { male, female };
  };
  
  const unassigned = getUnassignedStudents();
  
  return `
    <div class="bg-white p-4 rounded-lg shadow-md">
      <div class="flex justify-between items-center mb-4">
        <h3 class="text-xl font-bold">팀 편성 결과</h3>
        <button id="download-teams-btn" class="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition-colors font-medium flex items-center gap-2">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
          </svg>
          엑셀 다운로드
        </button>
      </div>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        ${teams.map(team => `
          <div class="text-center p-3 bg-blue-50 rounded-lg">
            <div class="text-sm text-gray-600">팀 ${team.id}</div>
            <div class="text-2xl font-bold text-blue-600">${team.members.length}명</div>
            ${team.averageRecord ? `<div class="text-xs text-gray-500 mt-1">평균: ${team.averageRecord.toFixed(1)}</div>` : ''}
            ${showGenderInfo ? `<div class="text-xs text-gray-500 mt-1">남 ${getGenderCounts(team).male}명 / 여 ${getGenderCounts(team).female}명</div>` : ''}
          </div>
        `).join('')}
      </div>
    </div>
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      ${teams.map(team => `
        <div class="bg-white p-4 rounded-lg shadow-md border-2 border-gray-200">
          <div class="flex justify-between items-center mb-3">
            <h3 class="text-lg font-bold text-gray-800">팀 ${team.id} (${team.members.length}명)</h3>
            ${team.averageRecord ? `<span class="text-sm text-gray-600">평균: ${team.averageRecord.toFixed(1)}${showGenderInfo ? ` | 남 ${getGenderCounts(team).male}명 / 여 ${getGenderCounts(team).female}명` : ''}</span>` : ''}
          </div>
          <div class="space-y-2 mb-3">
            ${team.members.map(member => `
              <div class="flex justify-between items-center p-2 bg-gray-50 rounded hover:bg-gray-100 transition-colors">
                <div class="flex-1">
                  <span class="text-sm font-medium text-gray-700">${member.name}${showGenderInfo ? ` (${member.gender || '-'})` : ''}</span>
                  ${member.records.length > 0 ? `
                    <div class="text-xs text-gray-500 mt-1">
                      기록: ${member.records.map((r, idx) => `<span class="mr-1">${r}</span>`).join('')}
                    </div>
                  ` : ''}
                </div>
                ${mode === 'manual' ? `
                  <button class="remove-student-btn text-red-500 hover:text-red-700 text-xs px-2 py-1 rounded hover:bg-red-50 transition-colors" 
                    data-team-id="${team.id}" data-student-name="${member.name}">제거</button>
                ` : ''}
              </div>
            `).join('')}
          </div>
          ${mode === 'manual' ? `
            <div class="mt-3 pt-3 border-t border-gray-200">
              <select class="student-select w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mb-2" data-team-id="${team.id}">
                <option value="">학생 선택...</option>
                ${unassigned.map(student => `
                  <option value="${student.name}">${student.name}</option>
                `).join('')}
              </select>
              <button class="add-student-btn w-full bg-green-600 text-white py-1 px-3 rounded-lg hover:bg-green-700 transition-colors text-sm disabled:bg-gray-300 disabled:cursor-not-allowed" 
                data-team-id="${team.id}" disabled>추가</button>
            </div>
          ` : ''}
        </div>
      `).join('')}
    </div>
    ${mode === 'manual' && unassigned.length > 0 ? `
      <div class="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
        <p class="text-sm text-yellow-800">
          <strong>미배정 학생:</strong> ${unassigned.map(s => s.name).join(', ')}
        </p>
      </div>
    ` : ''}
  `;
}

function attachTeamEventListeners() {
  // 엑셀 다운로드 버튼
  const downloadBtn = document.getElementById('download-teams-btn');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => {
      downloadTeamsToExcel(false);
    });
  }
  
  document.querySelectorAll('.remove-student-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const teamId = Number(e.target.dataset.teamId);
      const studentName = e.target.dataset.studentName;
      teams = removeStudentFromTeam(teams, studentName, teamId);
      renderTeacherView();
    });
  });
  
  document.querySelectorAll('.student-select').forEach(select => {
    select.addEventListener('change', (e) => {
      const studentName = e.target.value;
      selectedStudent = students.find(s => s.name === studentName) || null;
      const addBtn = e.target.parentElement.querySelector('.add-student-btn');
      addBtn.disabled = !selectedStudent;
    });
  });
  
  document.querySelectorAll('.add-student-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      if (!selectedStudent) return;
      const teamId = Number(e.target.dataset.teamId);
      teams = addStudentToTeam(teams, selectedStudent, teamId);
      selectedStudent = null;
      renderTeacherView();
    });
  });
}

function handleFormTeams() {
  if (numTeams < 1 || numTeams > students.length) {
    alert('팀 수는 1 이상이고 학생 수 이하여야 합니다.');
    return;
  }
  
  if (mode === 'random') {
    teams = formRandomTeams(students, numTeams);
  } else if (mode === 'balanced') {
    teams = formBalancedTeams(students, numTeams);
  } else if (mode === 'gender_balanced') {
    teams = formGenderBalancedTeams(students, numTeams);
  } else {
    teams = initializeManualTeams(students, numTeams);
  }
  
  renderTeacherView();
}

// 학생용 뷰
function initializeAnonymizedStudents() {
  if (students.length === 0) {
    anonymizedStudents = [];
    return;
  }
  
  const shuffled = [...students];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  
  anonymizedStudents = shuffled.map((student, index) => {
    const originalIndex = students.findIndex(s => s.name === student.name);
    return {
      ...student,
      id: `학생${index + 1}`,
      originalIndex: originalIndex,
    };
  });
  
  // teams는 renderStudentView에서 초기화하지 않음 (팀 편성 중에는 유지)
  showFinalTeams = false;
}

function destroyStudentRecordCharts() {
  studentRecordChartInstances.forEach((c) => {
    try {
      c.destroy();
    } catch (_) {
      /* noop */
    }
  });
  studentRecordChartInstances = [];
}

function buildStudentRecordLabels(records) {
  return records.map((_, i) => `기록${i + 1}`);
}

function createStudentRecordCharts() {
  if (typeof Chart === 'undefined') return;
  document.querySelectorAll('.student-record-canvas').forEach((canvas) => {
    const idx = Number(canvas.dataset.anonIndex);
    const student = anonymizedStudents[idx];
    if (!student || !student.records || student.records.length === 0) return;

    const labels = buildStudentRecordLabels(student.records);
    const values = student.records.map((v) => Number(v));
    const maxVal = Math.max(...values, 0);
    const yMax = Math.max(5, Math.ceil(maxVal * 1.15));

    const dataset = {
      label: student.id,
      data: values,
      borderColor: 'rgb(37, 99, 235)',
      backgroundColor:
        studentRecordChartType === 'radar' ? 'rgba(37, 99, 235, 0.22)' : 'rgba(37, 99, 235, 0.12)',
      borderWidth: 2,
      pointBackgroundColor: 'rgb(37, 99, 235)',
      pointBorderColor: '#fff',
      pointRadius: studentRecordChartType === 'line' ? 4 : 3,
      pointHoverRadius: 5,
      fill: studentRecordChartType === 'radar',
      tension: studentRecordChartType === 'line' ? 0.15 : 0,
    };

    const commonPlugins = {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label(ctx) {
            return `${ctx.label}: ${ctx.formattedValue}`;
          },
        },
      },
    };

    let config;
    if (studentRecordChartType === 'radar') {
      config = {
        type: 'radar',
        data: { labels, datasets: [dataset] },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: commonPlugins,
          scales: {
            r: {
              beginAtZero: true,
              suggestedMin: 0,
              suggestedMax: yMax,
              ticks: { stepSize: 1, backdropColor: 'transparent' },
              pointLabels: { font: { size: 10 } },
            },
          },
        },
      };
    } else {
      config = {
        type: 'line',
        data: { labels, datasets: [dataset] },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: commonPlugins,
          scales: {
            x: {
              ticks: { font: { size: 10 }, maxRotation: 45 },
              grid: { display: false },
            },
            y: {
              beginAtZero: true,
              suggestedMax: yMax,
              ticks: { stepSize: 1 },
            },
          },
        },
      };
    }

    const chart = new Chart(canvas.getContext('2d'), config);
    studentRecordChartInstances.push(chart);
  });
}

function renderStudentView() {
  document.getElementById('teacher-view').classList.add('hidden');
  document.getElementById('student-view').classList.remove('hidden');

  destroyStudentRecordCharts();

  // anonymizedStudents가 비어있을 때만 초기화 (팀 편성 중에는 초기화하지 않음)
  if (anonymizedStudents.length === 0) {
    initializeAnonymizedStudents();
  }
  
  const container = document.getElementById('student-view');
  const getUnassignedStudents = () => {
    const assignedIds = new Set(teams.flatMap(team => team.members.map(m => m.id)));
    return anonymizedStudents.filter(s => !assignedIds.has(s.id));
  };
  
  const unassigned = getUnassignedStudents();
  const allStudentsAssigned = teams.length > 0 && unassigned.length === 0;
  const hasGender = hasGenderData(students);
  
  container.innerHTML = `
    <div class="w-full max-w-6xl mx-auto space-y-6">
      <div class="bg-white p-6 rounded-lg shadow-md">
        <h2 class="text-2xl font-bold mb-4">학생용 팀 편성 (이름 숨김)</h2>
        <p class="text-gray-600 mb-4">학생들은 이름 대신 데이터만 보고 팀을 편성할 수 있습니다.${hasGender ? ' 필요하면 성별을 표시할 수도 있습니다.' : ''}</p>
        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-2">팀 수</label>
            <input type="number" id="student-num-teams" min="1" max="${students.length}" value="${numTeams}" 
              class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
          </div>
          ${hasGender ? `
          <div>
            <label class="flex items-center cursor-pointer">
              <input type="checkbox" id="show-student-gender" ${showStudentGender ? 'checked' : ''} class="mr-2 w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500">
              <span class="text-sm font-medium text-gray-700">성별 표시</span>
            </label>
            <p class="text-xs text-gray-500 mt-1 ml-6">체크하면 학생 번호와 함께 성별(남/여)이 표시됩니다.</p>
          </div>
          ` : ''}
          <button id="init-teams-btn" class="w-full bg-blue-600 text-white py-3 px-4 rounded-lg hover:bg-blue-700 transition-colors font-medium text-lg shadow-md">
            팀 편성 시작
          </button>
          ${teams.length > 0 ? `
            <button id="reset-student-teams-btn" class="w-full bg-gray-500 text-white py-2 px-4 rounded-lg hover:bg-gray-600 transition-colors font-medium mt-2">
              편성 초기화
            </button>
          ` : ''}
        </div>
      </div>
      ${teams.length > 0 ? renderStudentTeams(unassigned, allStudentsAssigned) : ''}
    </div>
  `;
  
  // 이벤트 위임을 사용하여 student-view 컨테이너에 이벤트 리스너 추가
  container.onclick = (e) => {
    const chartTypeBtn = e.target.closest('[data-student-chart-type]');
    if (chartTypeBtn) {
      const t = chartTypeBtn.getAttribute('data-student-chart-type');
      if (t === 'line' || t === 'radar') {
        studentRecordChartType = t;
        renderStudentView();
      }
      return;
    }
    if (e.target.id === 'init-teams-btn') {
      e.preventDefault();
      const numTeamsInput = document.getElementById('student-num-teams');
      if (numTeamsInput) {
        numTeams = Number(numTeamsInput.value);
      }
      if (numTeams < 1 || numTeams > students.length) {
        alert('팀 수는 1 이상이고 학생 수 이하여야 합니다.');
        return;
      }
      if (anonymizedStudents.length === 0) {
        alert('학생 데이터가 없습니다. 파일을 다시 업로드해주세요.');
        return;
      }
      teams = initializeManualTeams(anonymizedStudents, numTeams);
      renderStudentView();
    } else if (e.target.id === 'reset-student-teams-btn') {
      e.preventDefault();
      teams = [];
      renderStudentView();
    }
  };
  
  container.oninput = (e) => {
    if (e.target.id === 'student-num-teams') {
      numTeams = Number(e.target.value);
    }
  };

  container.onchange = (e) => {
    if (e.target.id === 'show-student-gender') {
      showStudentGender = e.target.checked;
      renderStudentView();
    }
  };
  
  if (teams.length > 0) {
    attachStudentEventListeners(unassigned);
    
    // 팀 편성 확인하기 버튼 이벤트
    const showFinalBtn = document.getElementById('show-final-teams-btn');
    if (showFinalBtn) {
      showFinalBtn.onclick = () => {
        showFinalTeams = !showFinalTeams;
        renderStudentView();
      };
    }
    
    // 학생용 엑셀 다운로드 버튼 이벤트
    const downloadStudentBtn = document.getElementById('download-student-teams-btn');
    if (downloadStudentBtn) {
      downloadStudentBtn.onclick = () => {
        downloadTeamsToExcel(true);
      };
    }

    requestAnimationFrame(() => {
      createStudentRecordCharts();
    });
  }
}

function renderStudentGenderBadge(gender) {
  if (!showStudentGender || !gender) return '';
  const colorClass = gender === '남' ? 'bg-blue-100 text-blue-700' : 'bg-pink-100 text-pink-700';
  return `<span class="inline-block text-xs font-medium px-2 py-0.5 rounded ${colorClass}">${gender}</span>`;
}

function getStudentTeamGenderCounts(team) {
  const male = team.members.filter((m) => m.gender === '남').length;
  const female = team.members.filter((m) => m.gender === '여').length;
  return { male, female };
}

function renderStudentTeams(unassigned, allStudentsAssigned) {
  return `
    <div class="bg-white p-4 rounded-lg shadow-md">
      <h3 class="text-xl font-bold mb-4">팀 편성 현황</h3>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        ${teams.map(team => `
          <div class="text-center p-3 bg-blue-50 rounded-lg">
            <div class="text-sm text-gray-600">팀 ${team.id}</div>
            <div class="text-2xl font-bold text-blue-600">${team.members.length}명</div>
            ${team.averageRecord ? `<div class="text-xs text-gray-500 mt-1">평균: ${team.averageRecord.toFixed(1)}</div>` : ''}
            ${showStudentGender ? (() => {
              const { male, female } = getStudentTeamGenderCounts(team);
              return `<div class="text-xs text-gray-500 mt-1">남 ${male}명 / 여 ${female}명</div>`;
            })() : ''}
          </div>
        `).join('')}
      </div>
    </div>
    <div class="bg-white p-6 rounded-lg shadow-md">
      <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-4">
        <h3 class="text-xl font-bold">학생 데이터 (이름 숨김${showStudentGender ? ', 성별 표시' : ''})</h3>
        <div class="flex flex-col gap-1 shrink-0">
          <span class="text-xs text-gray-500">기록 표시 방식</span>
          <div class="inline-flex rounded-lg border border-gray-200 p-0.5 bg-gray-50" role="group" aria-label="기록 차트 유형">
            <button type="button" data-student-chart-type="line"
              class="px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                studentRecordChartType === 'line'
                  ? 'bg-white text-blue-700 shadow-sm'
                  : 'text-gray-600 hover:text-gray-800'
              }">
              꺾은선 (연속 데이터)
            </button>
            <button type="button" data-student-chart-type="radar"
              class="px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                studentRecordChartType === 'radar'
                  ? 'bg-white text-blue-700 shadow-sm'
                  : 'text-gray-600 hover:text-gray-800'
              }">
              레이더 (독립 항목)
            </button>
          </div>
        </div>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        ${anonymizedStudents.map((student, index) => {
          const isAssigned = teams.some(team => team.members.some(m => m.id === student.id));
          return `
            <div class="student-card p-3 rounded-lg border-2 transition-all ${
              isAssigned 
                ? 'bg-gray-100 border-gray-300 opacity-60 cursor-not-allowed' 
                : selectedStudentIndex === index
                ? 'bg-blue-100 border-blue-500 ring-2 ring-blue-300'
                : 'bg-white border-gray-200 hover:border-blue-300 hover:shadow-md cursor-pointer'
            }" data-index="${index}" ${isAssigned ? '' : 'style="cursor: pointer;"'}>
              <div class="flex items-center gap-2 mb-2">
                <span class="font-medium text-gray-800">${student.id}</span>
                ${renderStudentGenderBadge(student.gender)}
              </div>
              <div class="student-chart-area h-44 w-full relative">
                <canvas class="student-record-canvas" data-anon-index="${index}" aria-label="${student.id} 기록 차트"></canvas>
              </div>
              ${isAssigned ? '<div class="text-xs text-gray-500 mt-2">이미 배정됨</div>' : ''}
            </div>
          `;
        }).join('')}
      </div>
    </div>
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      ${teams.map(team => `
        <div class="bg-white p-4 rounded-lg shadow-md border-2 border-gray-200">
          <div class="flex justify-between items-center mb-3">
            <h3 class="text-lg font-bold text-gray-800">팀 ${team.id}</h3>
            ${team.averageRecord || showStudentGender ? `<span class="text-sm text-gray-600">${team.averageRecord ? `평균: ${team.averageRecord.toFixed(1)}` : ''}${team.averageRecord && showStudentGender ? ' | ' : ''}${showStudentGender ? (() => {
              const { male, female } = getStudentTeamGenderCounts(team);
              return `남 ${male}명 / 여 ${female}명`;
            })() : ''}</span>` : ''}
          </div>
          <div class="space-y-2 mb-3">
            ${team.members.map(member => {
              const studentId = member.id;
              return `
                <div class="flex justify-between items-center p-2 bg-gray-50 rounded">
                  <div>
                    <div class="flex items-center gap-2">
                      <span class="text-sm font-medium text-gray-700">${studentId}</span>
                      ${renderStudentGenderBadge(member.gender)}
                    </div>
                    <div class="text-xs text-gray-500">
                      ${member.records.map((r, idx) => `<span class="mr-2">기록${idx + 1}: ${r}</span>`).join('')}
                    </div>
                  </div>
                  <button class="remove-student-student-btn text-red-500 hover:text-red-700 text-xs" 
                    data-team-id="${team.id}" data-student-id="${studentId}">제거</button>
                </div>
              `;
            }).join('')}
          </div>
          <div class="mt-3 pt-3 border-t border-gray-200">
            <select class="student-select-student w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mb-2" data-team-id="${team.id}">
              <option value="">학생 선택...</option>
              ${unassigned.map(student => `
                <option value="${student.id}">${student.id}${showStudentGender && student.gender ? ` (${student.gender})` : ''} (기록: ${student.records.join(', ')})</option>
              `).join('')}
            </select>
            <button class="add-student-student-btn w-full bg-green-600 text-white py-1 px-3 rounded-lg hover:bg-green-700 transition-colors text-sm disabled:bg-gray-300 disabled:cursor-not-allowed" 
              data-team-id="${team.id}" disabled>추가</button>
          </div>
        </div>
      `).join('')}
    </div>
    ${unassigned.length > 0 ? `
      <div class="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
        <p class="text-sm text-yellow-800">
          <strong>미배정 학생:</strong> ${unassigned.map(s => s.id).join(', ')}
        </p>
      </div>
    ` : ''}
    <div class="bg-white p-6 rounded-lg shadow-md">
      <div class="flex justify-between items-center mb-4">
        <div>
          <h3 class="text-xl font-bold">${allStudentsAssigned ? '팀 편성 완료' : '팀 편성 현황'}</h3>
          ${allStudentsAssigned ? `
            <p class="text-sm text-green-600 mt-1">모든 학생이 팀에 배정되었습니다.</p>
          ` : `
            <p class="text-sm text-gray-500 mt-1">아직 배정되지 않은 학생이 있습니다. 확인하기를 눌러 현재까지의 팀 구성을 확인할 수 있습니다.</p>
          `}
        </div>
        <button id="show-final-teams-btn" class="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 transition-colors font-medium text-lg shadow-md whitespace-nowrap">
          ${showFinalTeams ? '숨기기' : '팀 편성 확인하기'}
        </button>
      </div>
      ${showFinalTeams ? renderFinalTeams(allStudentsAssigned) : ''}
    </div>
  `;
}

function renderFinalTeams(allStudentsAssigned) {
  return `
    <div class="mt-4 space-y-4">
      <div class="flex justify-end mb-2">
        <button id="download-student-teams-btn" class="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition-colors font-medium flex items-center gap-2">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
          </svg>
          엑셀 다운로드
        </button>
      </div>
      ${allStudentsAssigned ? `
        <div class="bg-green-50 border border-green-200 rounded-lg p-4 mb-4">
          <p class="text-green-800 font-medium">모든 학생이 팀에 배정되었습니다. 아래에서 최종 팀 명단을 확인하세요.</p>
        </div>
      ` : `
        <div class="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-4">
          <p class="text-yellow-800 font-medium">아직 배정되지 않은 학생이 있습니다. 현재까지의 팀 구성을 확인할 수 있습니다.</p>
        </div>
      `}
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        ${teams.map(team => `
          <div class="bg-blue-50 p-4 rounded-lg border-2 border-blue-200">
            <h4 class="text-lg font-bold text-blue-800 mb-3 text-center">팀 ${team.id} (${team.members.length}명)</h4>
            <div class="space-y-2">
              ${team.members.map(member => {
                const originalStudent = students[member.originalIndex];
                return `
                  <div class="bg-white p-3 rounded border border-blue-100">
                    <div class="font-medium text-gray-800 mb-1">${originalStudent.name}</div>
                    <div class="text-xs text-gray-500">(${member.id})</div>
                    ${originalStudent.records.length > 0 ? `
                      <div class="text-xs text-gray-400 mt-1">기록: ${originalStudent.records.join(', ')}</div>
                    ` : ''}
                  </div>
                `;
              }).join('')}
            </div>
            ${team.averageRecord ? `
              <div class="mt-3 pt-3 border-t border-blue-200 text-center">
                <span class="text-sm text-gray-600">평균 기록: <strong>${team.averageRecord.toFixed(1)}</strong></span>
              </div>
            ` : ''}
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function attachStudentEventListeners(unassigned) {
  document.querySelectorAll('.student-chart-area').forEach((el) => {
    el.addEventListener('click', (e) => e.stopPropagation());
  });

  document.querySelectorAll('.student-card').forEach(card => {
    if (!card.classList.contains('opacity-60')) {
      card.addEventListener('click', (e) => {
        const index = Number(e.target.closest('.student-card').dataset.index);
        selectedStudentIndex = index;
        renderStudentView();
      });
    }
  });
  
  document.querySelectorAll('.remove-student-student-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const teamId = Number(e.target.dataset.teamId);
      const studentId = e.target.dataset.studentId;
      teams = removeStudentFromTeam(teams, studentId, teamId);
      renderStudentView();
    });
  });
  
  document.querySelectorAll('.student-select-student').forEach(select => {
    select.addEventListener('change', (e) => {
      const studentId = e.target.value;
      const index = anonymizedStudents.findIndex(s => s.id === studentId);
      selectedStudentIndex = index !== -1 ? index : null;
      const addBtn = e.target.parentElement.querySelector('.add-student-student-btn');
      addBtn.disabled = selectedStudentIndex === null;
    });
  });
  
  document.querySelectorAll('.add-student-student-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      if (selectedStudentIndex === null) return;
      const student = anonymizedStudents[selectedStudentIndex];
      const teamId = Number(e.target.dataset.teamId);
      teams = addStudentToTeam(teams, student, teamId);
      selectedStudentIndex = null;
      renderStudentView();
    });
  });
}

// 초기화
document.addEventListener('DOMContentLoaded', () => {
  const fileInput = document.getElementById('file-input');
  const dropZone = document.getElementById('drop-zone');
  const teacherBtn = document.getElementById('teacher-btn');
  const studentBtn = document.getElementById('student-btn');
  const resetBtn = document.getElementById('reset-btn');
  
  // 파일 업로드
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
      await handleFileUpload(file);
    }
  });
  
  // 드래그 앤 드롭
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('border-blue-500', 'bg-blue-50');
    dropZone.classList.remove('border-gray-300', 'bg-gray-50');
  });
  
  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('border-blue-500', 'bg-blue-50');
    dropZone.classList.add('border-gray-300', 'bg-gray-50');
  });
  
  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone.classList.remove('border-blue-500', 'bg-blue-50');
    dropZone.classList.add('border-gray-300', 'bg-gray-50');
    
    const file = e.dataTransfer.files[0];
    if (file) {
      await handleFileUpload(file);
    }
  });
  
  // 뷰 모드 전환
  teacherBtn.addEventListener('click', () => {
    viewMode = 'teacher';
    updateViewButtons();
    renderMainView();
  });
  
  studentBtn.addEventListener('click', () => {
    viewMode = 'student';
    // 학생용 뷰로 전환할 때 anonymizedStudents 초기화
    anonymizedStudents = [];
    teams = [];
    selectedStudentIndex = null;
    showFinalTeams = false;
    showStudentGender = false;
    updateViewButtons();
    renderMainView();
  });
  
  resetBtn.addEventListener('click', () => {
    students = [];
    viewMode = 'upload';
    teams = [];
    selectedStudent = null;
    selectedStudentIndex = null;
    showFinalTeams = false;
    showStudentGender = false;
    anonymizedStudents = [];
    document.getElementById('upload-view').classList.remove('hidden');
    document.getElementById('main-view').classList.add('hidden');
    hideError();
  });
  
  function updateViewButtons() {
    if (viewMode === 'teacher') {
      teacherBtn.className = 'px-4 py-2 rounded-lg font-medium transition-colors bg-blue-600 text-white';
      studentBtn.className = 'px-4 py-2 rounded-lg font-medium transition-colors bg-gray-200 text-gray-700 hover:bg-gray-300';
    } else {
      teacherBtn.className = 'px-4 py-2 rounded-lg font-medium transition-colors bg-gray-200 text-gray-700 hover:bg-gray-300';
      studentBtn.className = 'px-4 py-2 rounded-lg font-medium transition-colors bg-blue-600 text-white';
    }
  }
  
  async function handleFileUpload(file) {
    if (!file.name.endsWith('.xlsx') && !file.name.endsWith('.xls')) {
      showError('엑셀 파일(.xlsx, .xls)만 업로드 가능합니다.');
      return;
    }
    
    hideError();
    try {
      students = await parseExcelFile(file);
      viewMode = 'teacher';
      updateViewButtons();
      renderMainView();
    } catch (err) {
      showError(err.message || '파일을 읽는 중 오류가 발생했습니다.');
    }
  }
});

