<template>
  <div class="formula-test-container">
    <h2>公式引擎测试</h2>

    <div class="test-section">
      <h3>输入测试</h3>
      <el-input
        v-model="testFormula"
        placeholder="输入公式，例如: =SUM(1,2,3)"
        @keyup.enter="evaluateTestFormula"
      />
      <el-button type="primary" @click="evaluateTestFormula">计算</el-button>
      <div v-if="testResult" class="result">
        结果: {{ testResult }}
      </div>
    </div>

    <div class="test-section">
      <h3>预设测试</h3>
      <el-table :data="testCases" stripe>
        <el-table-column prop="category" label="分类" width="120" />
        <el-table-column prop="formula" label="公式" />
        <el-table-column label="结果">
          <template #default="{ row }">
            <span :class="{ error: row.result?.toString().startsWith('#') }">
              {{ row.result }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="80">
          <template #default="{ row }">
            <el-tag :type="row.status === 'success' ? 'success' : 'danger'">
              {{ row.status === 'success' ? '成功' : '失败' }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { formulaEngine } from '../utils/formulaEngine'

const testFormula = ref('')
const testResult = ref('')

const testCases = ref([
  // 数学函数
  { category: '数学', formula: '=SUM(1,2,3,4,5)', result: '', status: '' },
  { category: '数学', formula: '=AVERAGE(10,20,30)', result: '', status: '' },
  { category: '数学', formula: '=ROUND(3.14159, 2)', result: '', status: '' },
  { category: '数学', formula: '=POWER(2, 8)', result: '', status: '' },
  { category: '数学', formula: '=SQRT(16)', result: '', status: '' },
  { category: '数学', formula: '=MAX(5,3,9,1)', result: '', status: '' },
  { category: '数学', formula: '=MIN(5,3,9,1)', result: '', status: '' },

  // 文本函数
  { category: '文本', formula: '=CONCAT("Hello", " ", "World")', result: '', status: '' },
  { category: '文本', formula: '=UPPER("hello")', result: '', status: '' },
  { category: '文本', formula: '=LOWER("WORLD")', result: '', status: '' },
  { category: '文本', formula: '=LEN("MetaSheet")', result: '', status: '' },
  { category: '文本', formula: '=LEFT("MetaSheet", 4)', result: '', status: '' },
  { category: '文本', formula: '=RIGHT("MetaSheet", 5)', result: '', status: '' },

  // 日期函数
  { category: '日期', formula: '=TODAY()', result: '', status: '' },
  { category: '日期', formula: '=YEAR("2024-03-15")', result: '', status: '' },
  { category: '日期', formula: '=MONTH("2024-03-15")', result: '', status: '' },
  { category: '日期', formula: '=DAY("2024-03-15")', result: '', status: '' },

  // 逻辑函数
  { category: '逻辑', formula: '=IF(5>3, "TRUE", "FALSE")', result: '', status: '' },
  { category: '逻辑', formula: '=AND(TRUE, TRUE, TRUE)', result: '', status: '' },
  { category: '逻辑', formula: '=OR(FALSE, TRUE, FALSE)', result: '', status: '' },
  { category: '逻辑', formula: '=NOT(FALSE)', result: '', status: '' },

  // 统计函数
  { category: '统计', formula: '=MEDIAN(1,2,3,4,5)', result: '', status: '' },
  { category: '统计', formula: '=MODE(1,2,2,3,3,3,4)', result: '', status: '' },

  // 业务函数
  { category: '业务', formula: '=IDCARD_AGE("110101199001011234")', result: '', status: '' },
  { category: '业务', formula: '=IDCARD_GENDER("110101199001011234")', result: '', status: '' },

  // 嵌套函数
  { category: '嵌套', formula: '=ROUND(AVERAGE(1,2,3,4,5), 1)', result: '', status: '' },
  { category: '嵌套', formula: '=IF(SUM(1,2,3)>5, "大于5", "小于等于5")', result: '', status: '' }
])

function evaluateTestFormula() {
  try {
    testResult.value = formulaEngine.evaluate(testFormula.value)
  } catch (error) {
    testResult.value = '#ERROR! ' + (error as Error).message
  }
}

function runAllTests() {
  testCases.value.forEach((testCase) => {
    try {
      testCase.result = formulaEngine.evaluate(testCase.formula)
      testCase.status = testCase.result?.toString().startsWith('#') ? 'error' : 'success'
    } catch (error) {
      testCase.result = '#ERROR!'
      testCase.status = 'error'
    }
  })
}

onMounted(() => {
  runAllTests()
})
</script>

<style scoped>
.formula-test-container {
  padding: 20px;
  max-width: 1200px;
  margin: 0 auto;
}

.test-section {
  margin-bottom: 30px;
}

.test-section h3 {
  margin-bottom: 15px;
  color: #333;
}

.result {
  margin-top: 10px;
  padding: 10px;
  background: #f0f0f0;
  border-radius: 4px;
  font-family: monospace;
}

.error {
  color: red;
}

.el-input {
  width: 400px;
  margin-right: 10px;
}
</style>