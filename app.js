// 전역 상태
let students = [];
let viewMode = 'upload'; // 'upload' | 'teacher' | 'student'
let numTeams = 4;
let mode = 'random'; // 'random' | 'balanced' | 'manual'
let teams = [];
let selectedStudent = null;
let selectedStudentIndex = null;
let showFinalTeams = false;
let anonymizedStudents = [];

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
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
        
        if (jsonData.length < 2) {
          reject(new Error('엑셀 파일에 데이터가 충분하지 않습니다.'));
          return;
        }
        
        const headers = jsonData[0];
        const nameColumnIndex = headers.findIndex(h => 
          h && (h.includes('이름') || h.includes('name') || h.includes('Name'))
        );
        
        if (nameColumnIndex === -1) {
          reject(new Error('이름 열을 찾을 수 없습니다. 헤더에 "이름"이 포함되어야 합니다.'));
          return;
        }
        
        const recordColumnIndices = [];
        headers.forEach((header, index) => {
          if (index !== nameColumnIndex && header) {
            const firstDataRow = jsonData[1];
            if (firstDataRow && firstDataRow[index] !== undefined) {
              const value = firstDataRow[index];
              if (typeof value === 'number' || !isNaN(Number(value))) {
                recordColumnIndices.push(index);
              }
            }
          }
        });
        
        if (recordColumnIndices.length === 0) {
          reject(new Error('숫자 기록 열을 찾을 수 없습니다.'));
          return;
        }
        
        const parsedStudents = [];
        for (let i = 1; i < jsonData.length; i++) {
          const row = jsonData[i];
          if (!row || !row[nameColumnIndex]) continue;
          
          const name = String(row[nameColumnIndex]).trim();
          if (!name) continue;
          
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
            parsedStudents.push({ name, records });
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

function formBalancedTeams(students, numTeams) {
  if (numTeams < 1 || students.length === 0) return [];
  
  const studentsWithScore = students.map(student => ({
    ...student,
    totalScore: student.records.length > 0 
      ? student.records.reduce((sum, r) => sum + r, 0) / student.records.length
      : 0,
  }));
  
  studentsWithScore.sort((a, b) => b.totalScore - a.totalScore);
  
  const teams = Array.from({ length: numTeams }, (_, i) => ({
    id: i + 1,
    members: [],
    averageRecord: 0,
  }));
  
  const teamScores = new Array(numTeams).fill(0);
  
  studentsWithScore.forEach((student) => {
    let minScoreIndex = 0;
    let minScore = teamScores[0];
    
    for (let i = 1; i < numTeams; i++) {
      if (teamScores[i] < minScore) {
        minScore = teamScores[i];
        minScoreIndex = i;
      }
    }
    
    teams[minScoreIndex].members.push({
      name: student.name,
      records: student.records,
    });
    
    teamScores[minScoreIndex] += student.totalScore;
  });
  
  teams.forEach(team => {
    if (team.members.length > 0 && team.members[0].records.length > 0) {
      const allRecords = team.members.flatMap(s => s.records);
      team.averageRecord = allRecords.reduce((sum, r) => sum + r, 0) / allRecords.length;
    }
  });
  
  return teams;
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
                <span>밸런스 편성 (기록 기반 균형)</span>
              </label>
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
  
  const unassigned = getUnassignedStudents();
  
  return `
    <div class="bg-white p-4 rounded-lg shadow-md">
      <h3 class="text-xl font-bold mb-4">팀 편성 결과</h3>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        ${teams.map(team => `
          <div class="text-center p-3 bg-blue-50 rounded-lg">
            <div class="text-sm text-gray-600">팀 ${team.id}</div>
            <div class="text-2xl font-bold text-blue-600">${team.members.length}명</div>
            ${team.averageRecord ? `<div class="text-xs text-gray-500 mt-1">평균: ${team.averageRecord.toFixed(1)}</div>` : ''}
          </div>
        `).join('')}
      </div>
    </div>
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      ${teams.map(team => `
        <div class="bg-white p-4 rounded-lg shadow-md border-2 border-gray-200">
          <div class="flex justify-between items-center mb-3">
            <h3 class="text-lg font-bold text-gray-800">팀 ${team.id} (${team.members.length}명)</h3>
            ${team.averageRecord ? `<span class="text-sm text-gray-600">평균: ${team.averageRecord.toFixed(1)}</span>` : ''}
          </div>
          <div class="space-y-2 mb-3">
            ${team.members.map(member => `
              <div class="flex justify-between items-center p-2 bg-gray-50 rounded hover:bg-gray-100 transition-colors">
                <div class="flex-1">
                  <span class="text-sm font-medium text-gray-700">${member.name}</span>
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
  
  teams = [];
  showFinalTeams = false;
}

function renderStudentView() {
  document.getElementById('teacher-view').classList.add('hidden');
  document.getElementById('student-view').classList.remove('hidden');
  
  initializeAnonymizedStudents();
  
  const container = document.getElementById('student-view');
  const getUnassignedStudents = () => {
    const assignedIds = new Set(teams.flatMap(team => team.members.map(m => m.id)));
    return anonymizedStudents.filter(s => !assignedIds.has(s.id));
  };
  
  const unassigned = getUnassignedStudents();
  const allStudentsAssigned = teams.length > 0 && unassigned.length === 0;
  
  container.innerHTML = `
    <div class="w-full max-w-6xl mx-auto space-y-6">
      <div class="bg-white p-6 rounded-lg shadow-md">
        <h2 class="text-2xl font-bold mb-4">학생용 팀 편성 (이름 숨김)</h2>
        <p class="text-gray-600 mb-4">학생들은 이름 대신 데이터만 보고 팀을 편성할 수 있습니다.</p>
        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-2">팀 수</label>
            <input type="number" id="student-num-teams" min="1" max="${students.length}" value="${numTeams}" 
              class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
          </div>
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
  
  document.getElementById('student-num-teams').addEventListener('input', (e) => {
    numTeams = Number(e.target.value);
  });
  
  document.getElementById('init-teams-btn').addEventListener('click', () => {
    if (numTeams < 1 || numTeams > students.length) {
      alert('팀 수는 1 이상이고 학생 수 이하여야 합니다.');
      return;
    }
    teams = initializeManualTeams(anonymizedStudents, numTeams);
    renderStudentView();
  });
  
  if (teams.length > 0) {
    document.getElementById('reset-student-teams-btn').addEventListener('click', () => {
      teams = [];
      renderStudentView();
    });
    attachStudentEventListeners(unassigned);
  }
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
          </div>
        `).join('')}
      </div>
    </div>
    <div class="bg-white p-6 rounded-lg shadow-md">
      <h3 class="text-xl font-bold mb-4">학생 데이터 (이름 숨김)</h3>
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
              <div class="font-medium text-gray-800 mb-2">${student.id}</div>
              <div class="text-sm text-gray-600 space-y-1">
                ${student.records.map((record, idx) => `
                  <div>기록${idx + 1}: ${record}</div>
                `).join('')}
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
            ${team.averageRecord ? `<span class="text-sm text-gray-600">평균: ${team.averageRecord.toFixed(1)}</span>` : ''}
          </div>
          <div class="space-y-2 mb-3">
            ${team.members.map(member => {
              const studentId = member.id;
              return `
                <div class="flex justify-between items-center p-2 bg-gray-50 rounded">
                  <div>
                    <div class="text-sm font-medium text-gray-700">${studentId}</div>
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
                <option value="${student.id}">${student.id} (기록: ${student.records.join(', ')})</option>
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
  
  document.getElementById('show-final-teams-btn').addEventListener('click', () => {
    showFinalTeams = !showFinalTeams;
    renderStudentView();
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

