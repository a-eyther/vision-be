import xlsx from 'xlsx';
import fs from 'fs/promises';
import path from 'path';

// Parse numeric values (same as frontend)
const parseNumber = (value) => {
  if (!value || value === '') return 0;
  const cleaned = value.toString().replace(/[^0-9.-]/g, '');
  return parseFloat(cleaned) || 0;
};

// Parse date strings from various formats
const parseDate = (dateString) => {
  if (!dateString) return null;
  if (dateString instanceof Date) return dateString;
  if (typeof dateString !== 'string') return null;
  const trimmed = dateString.trim();
  if (trimmed === '') return null;

  // Handle custom format: ' 17,February , 2025 12:00 AM'
  const customMatch = trimmed.match(/^(\d{1,2}),([A-Za-z]+)\s*,\s*(\d{4})\s*(.*)$/);
  if (customMatch) {
    const day = customMatch[1];
    const month = customMatch[2];
    const year = customMatch[3];
    const time = customMatch[4] || '00:00 AM';
    const reformatted = `${day} ${month} ${year} ${time}`;
    const parsed = new Date(reformatted);
    if (!isNaN(parsed)) return parsed;
  }

  // Fallback to standard parsing
  const parsed = new Date(trimmed);
  if (!isNaN(parsed)) return parsed;
  return null;
};

// Read and parse CSV/Excel file
export const parseCSVFile = async (filePath) => {
  try {
    // Read the file
    const buffer = await fs.readFile(filePath);
    
    // Parse using xlsx
    const workbook = xlsx.read(buffer, { type: 'buffer' });
    
    // Get the first sheet
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    // Convert to JSON
    const jsonData = xlsx.utils.sheet_to_json(worksheet, { raw: false });
    
    if (!jsonData || jsonData.length === 0) {
      throw new Error('No data found in the file');
    }
    
    return jsonData;
  } catch (error) {
    throw new Error(`Failed to parse CSV file: ${error.message}`);
  }
};

// Validate required columns for MAA Yojna data
export const validateMAAClaims = (data) => {
  if (!data || data.length === 0) {
    return { valid: false, error: 'No data found' };
  }
  
  const requiredColumns = [
    'TID',
    'Patient Name',
    'Hospital Name',
    'Status',
    'Pkg Rate',
    'Approved Amount'
  ];
  
  const sampleRow = data[0];
  const missingColumns = requiredColumns.filter(col => !(col in sampleRow));
  
  if (missingColumns.length > 0) {
    return { 
      valid: false, 
      error: `Missing required columns: ${missingColumns.join(', ')}` 
    };
  }
  
  return { valid: true };
};

// Preprocess MAA claims data
export const preprocessMAAClaims = (data) => {
  return data.map(row => {
    const processedRow = { ...row };
    
    // Parse numeric fields
    processedRow['Pkg Rate'] = parseNumber(row['Pkg Rate']);
    processedRow['Approved Amount'] = parseNumber(row['Approved Amount']);
    processedRow['Query Raised'] = parseNumber(row['Query Raised'] || '0');
    
    // Parse dates
    processedRow['Date of Admission'] = parseDate(row['Date of Admission']);
    processedRow['Date of Discharge'] = parseDate(row['Date of Discharge']);
    processedRow['Payment Date'] = parseDate(row['Payment Date']);
    
    // Calculate days to payment if not provided
    if (row['Days to Payment']) {
      processedRow['Days to Payment'] = parseNumber(row['Days to Payment']);
    } else if (processedRow['Date of Discharge'] && processedRow['Payment Date']) {
      // Calculate from discharge to payment date
      const daysDiff = Math.floor((processedRow['Payment Date'] - processedRow['Date of Discharge']) / (1000 * 60 * 60 * 24));
      processedRow['Days to Payment'] = Math.max(0, daysDiff);
    } else {
      processedRow['Days to Payment'] = 0;
    }
    
    // Calculate actual paid amount based on status
    processedRow['Actual Paid Amount'] = 
      row['Status'] && row['Status'].includes('Claim Paid')
        ? processedRow['Approved Amount']
        : 0;
    
    return processedRow;
  });
};

// Group data by TID (each TID represents one claim)
export const groupDataByTID = (data) => {
  const groupedByTID = data.reduce((acc, row) => {
    const tid = row['TID'];
    if (!tid) return acc;

    if (!acc[tid]) {
      // Initialize claim with first row data
      acc[tid] = {
        ...row,
        'Pkg Rate': 0,
        'Approved Amount': 0,
        'Actual Paid Amount': 0,
        'Query Raised': 0,
        components: []
      };
    }

    // Add component details
    acc[tid].components.push({
      'Pkg Code': row['Pkg Code'],
      'Pkg Name': row['Pkg Name'],
      'Component Pkg Rate': row['Pkg Rate'],
      'Component Approved Amount': row['Approved Amount']
    });

    // Sum up amounts for the claim
    acc[tid]['Pkg Rate'] += row['Pkg Rate'];
    acc[tid]['Approved Amount'] += row['Approved Amount'];
    acc[tid]['Actual Paid Amount'] += row['Actual Paid Amount'];
    
    // For query and payment days, use the maximum value
    acc[tid]['Query Raised'] = Math.max(acc[tid]['Query Raised'], row['Query Raised']);
    acc[tid]['Days to Payment'] = Math.max(acc[tid]['Days to Payment'], row['Days to Payment']);

    return acc;
  }, {});

  return Object.values(groupedByTID);
};

// Calculate key metrics for proposal generation
export const calculateProposalMetrics = (data) => {
  // Preprocess and group data
  const processedData = preprocessMAAClaims(data);
  const groupedData = groupDataByTID(processedData);
  
  // Basic statistics
  const totalClaims = groupedData.length;
  const totalClaimValue = groupedData.reduce((sum, row) => sum + row['Pkg Rate'], 0);
  const totalApprovedAmount = groupedData.reduce((sum, row) => sum + row['Approved Amount'], 0);
  const totalPaidAmount = processedData
    .filter(row => row['Status'] && row['Status'].includes('Claim Paid'))
    .reduce((sum, row) => sum + row['Approved Amount'], 0);
  
  // Status counts
  const paidClaims = groupedData.filter(row => 
    row['Status'] && row['Status'].includes('Claim Paid')
  ).length;
  
  const rejectedClaims = groupedData.filter(row => 
    row['Status'] && (
      row['Status'] === 'Claim Rejected (Supervisor)' ||
      row['Status'] === 'Claim Rejected (Analyser)'
    )
  ).length;
  
  const pendingClaims = groupedData.filter(row => 
    row['Status'] && row['Status'].includes('Pending')
  ).length;
  
  const approvedClaims = groupedData.filter(row => 
    row['Status'] && row['Status'].includes('Approved')
  ).length;
  
  // Query analysis
  const claimsWithQuery = groupedData.filter(row => row['Query Raised'] > 0).length;
  const claimsWithoutQuery = groupedData.filter(row => row['Query Raised'] === 0).length;
  
  // Calculate KPIs
  const denialRate = totalClaims > 0 ? (rejectedClaims / totalClaims) * 100 : 0;
  const queryIncidence = totalClaims > 0 ? (claimsWithQuery / totalClaims) * 100 : 0;
  const firstPassRate = totalClaims > 0 ? (claimsWithoutQuery / totalClaims) * 100 : 0;
  const collectionEfficiency = totalApprovedAmount > 0 
    ? (totalPaidAmount / totalApprovedAmount) * 100 
    : 0;
  
  // Revenue leakage (rejected claims amount)
  const rejectedClaimsAmount = processedData
    .filter(row => row['Status'] && (
      row['Status'] === 'Claim Rejected (Supervisor)' ||
      row['Status'] === 'Claim Rejected (Analyser)'
    ))
    .reduce((sum, row) => sum + row['Pkg Rate'], 0);
  
  const revenueLeakageRate = totalClaimValue > 0 
    ? (rejectedClaimsAmount / totalClaimValue) * 100 
    : 0;
  
  // Outstanding revenue (approved but unpaid)
  const approvedUnpaidAmount = processedData
    .filter(row => 
      row['Status'] && 
      row['Status'].toLowerCase().includes('approved') && 
      row['Status'].toLowerCase().includes('supervisor')
    )
    .reduce((sum, row) => sum + row['Approved Amount'], 0);
  
  // Revenue stuck in query
  const revenueStuckInQuery = processedData
    .filter(row => row['Status'] && row['Status'].toLowerCase().includes('claim query'))
    .reduce((sum, row) => sum + row['Pkg Rate'], 0);
  
  // Average claim amount (rounded to nearest rupee)
  const averageClaimAmount = totalClaims > 0 ? Math.round(totalClaimValue / totalClaims) : 0;
  
  // Calculate average length of stay instead of days to payment
  const claimsWithDates = groupedData.filter(row => 
    row['Date of Admission'] && row['Date of Discharge']
  );
  
  const avgLengthOfStay = claimsWithDates.length > 0
    ? claimsWithDates.reduce((sum, row) => {
        const los = Math.floor((row['Date of Discharge'] - row['Date of Admission']) / (1000 * 60 * 60 * 24));
        return sum + Math.max(0, los);
      }, 0) / claimsWithDates.length
    : 4; // default 4 days

  // NEW: Calculate avgDaysToPayment from Days to Payment if available
  const claimsWithPaymentDays = groupedData.filter(row => row['Days to Payment'] && row['Days to Payment'] > 0);
  const avgDaysToPayment = claimsWithPaymentDays.length > 0
    ? claimsWithPaymentDays.reduce((sum, row) => sum + row['Days to Payment'], 0) / claimsWithPaymentDays.length
    : (avgLengthOfStay || 45); // fallback to length of stay or 45
  
  // Date range
  const admissionDates = processedData
    .map(row => row['Date of Admission'])
    .filter(date => date instanceof Date && !isNaN(date));
  
  const minDate = admissionDates.length > 0 
    ? admissionDates.reduce((min, date) => date < min ? date : min, admissionDates[0])
    : null;
    
  const maxDate = admissionDates.length > 0
    ? admissionDates.reduce((max, date) => date > max ? date : max, admissionDates[0])
    : null;
    
  // Calculate months span for monthly claim value
  const monthsSpan = minDate && maxDate 
    ? Math.max(1, Math.ceil((maxDate - minDate) / (1000 * 60 * 60 * 24 * 30)))
    : 12; // default to 12 months if dates not available
  
  // High value claims (>1L)
  const highValueClaims = groupedData.filter(row => row['Pkg Rate'] > 100000).length;
  const highValueClaimsPercentage = totalClaims > 0 
    ? (highValueClaims / totalClaims) * 100 
    : 0;
  
  // Top denial reasons (simplified for proposal)
  const denialReasons = [
    { reason: 'Missing or incorrect documentation', percentage: 35 },
    { reason: 'Authorization issues', percentage: 25 },
    { reason: 'Coding errors', percentage: 20 },
    { reason: 'Eligibility verification failures', percentage: 12 },
    { reason: 'Timely filing issues', percentage: 8 }
  ];
  
  return {
    // Basic metrics
    totalClaims,
    paidClaims,
    approvedClaims,
    rejectedClaims,
    pendingClaims,
    
    // Financial metrics
    totalClaimValue,
    totalApprovedAmount,
    totalPaidAmount,
    averageClaimAmount,
    rejectedClaimsAmount,
    approvedUnpaidAmount,
    revenueStuckInQuery,
    
    // KPIs
    denialRate,
    queryIncidence,
    firstPassRate,
    collectionEfficiency,
    revenueLeakageRate,
    highValueClaimsPercentage,
    
    // Processing metrics
    avgLengthOfStay,
    avgDaysToPayment, // use new calculation
    claimsWithQuery,
    claimsWithoutQuery,
    
    // Date range
    minDate,
    maxDate,
    dateRangeText: minDate && maxDate 
      ? `${minDate.toLocaleDateString('en-IN')} to ${maxDate.toLocaleDateString('en-IN')}`
      : 'N/A',
    
    // Denial reasons
    denialReasons,
    
    // Health score calculation
    healthScore: Math.min(90, (100 - denialRate) * 0.4 + collectionEfficiency * 0.4 + (100 - queryIncidence) * 0.2),
    
    // Months span for calculations
    monthsSpan
  };
};

// Calculate ROI projections based on metrics
export const calculateROIProjections = (metrics) => {
  const { 
    totalClaimValue, 
    rejectedClaimsAmount, 
    denialRate,
    firstPassRate,
    avgDaysToPayment
  } = metrics;
  
  // Ensure we have minimum values for calculation
  const safeClaimValue = totalClaimValue || 5000000; // 50L default
  const safeRejectedAmount = rejectedClaimsAmount || (safeClaimValue * 0.15); // 15% default denial
  const safeDenialRate = denialRate || 15;
  const safeAvgDays = avgDaysToPayment || 45;
  
  // Conservative scenario: Reduce denial rate to 5%
  const targetDenialRate = 5;
  const potentialRecovery = (safeDenialRate > targetDenialRate)
    ? safeRejectedAmount * ((safeDenialRate - targetDenialRate) / safeDenialRate)
    : safeRejectedAmount * 0.5; // Fallback to 50% recovery
  
  // Working capital improvement from faster payments
  const targetDaysToPayment = 30;
  const daysSaved = Math.max(0, safeAvgDays - targetDaysToPayment);
  const workingCapitalBenefit = safeClaimValue * (daysSaved / 365) * 0.12; // 12% cost of capital
  
  // Process efficiency savings (reduced manual work)
  const processEfficiencySavings = safeClaimValue * 0.02; // 2% of claim value
  
  // Calculate projections
  const conservativeRecovery = potentialRecovery * 0.6;
  const expectedRecovery = potentialRecovery * 0.8;
  const optimisticRecovery = potentialRecovery;
  
  const conservativeTotal = conservativeRecovery + workingCapitalBenefit * 0.5 + processEfficiencySavings * 0.5;
  const expectedTotal = expectedRecovery + workingCapitalBenefit * 0.7 + processEfficiencySavings * 0.7;
  const optimisticTotal = optimisticRecovery + workingCapitalBenefit + processEfficiencySavings;
  
  // Calculate payback period (months) - using a fixed ROI multiple of 3.5 internally
  const roiMultiple = 3.5;
  const investmentAmount = expectedTotal / roiMultiple;
  const monthlyBenefit = expectedTotal / 12;
  const paybackMonths = Math.ceil(investmentAmount / monthlyBenefit);
  
  return {
    denialPreventionConservative: conservativeRecovery,
    denialPreventionExpected: expectedRecovery,
    denialPreventionOptimistic: optimisticRecovery,
    
    collectionsConservative: workingCapitalBenefit * 0.5,
    collectionsExpected: workingCapitalBenefit * 0.7,
    collectionsOptimistic: workingCapitalBenefit,
    
    efficiencyConservative: processEfficiencySavings * 0.5,
    efficiencyExpected: processEfficiencySavings * 0.7,
    efficiencyOptimistic: processEfficiencySavings,
    
    totalBenefitConservative: conservativeTotal,
    totalBenefitExpected: expectedTotal,
    totalBenefitOptimistic: optimisticTotal,
    
    paybackPeriod: paybackMonths,
    roiMultiple: roiMultiple
  };
};

// Main function to process CSV and generate proposal data
export const processCSVForProposal = async (filePath, additionalParams = {}) => {
  try {
    // Parse CSV file
    const rawData = await parseCSVFile(filePath);
    
    // Validate data
    const validation = validateMAAClaims(rawData);
    if (!validation.valid) {
      throw new Error(validation.error);
    }
    
    // Calculate metrics
    const metrics = calculateProposalMetrics(rawData);
    
    // Ensure we have default values for critical metrics
    if (!metrics.avgDaysToPayment || metrics.avgDaysToPayment === 0) {
      metrics.avgDaysToPayment = 45; // default value
    }
    if (!metrics.averageClaimAmount || metrics.averageClaimAmount === 0) {
      metrics.averageClaimAmount = 50000; // default ₹50,000
    }
    
    // Calculate ROI projections
    const roiProjections = calculateROIProjections(metrics);
    
    // Format numbers for display with dynamic truncation
    const formatIndianNumber = (num, maxLength = 12) => {
      // Handle undefined, null, or 0 values
      if (!num || num === 0) {
        return '0';
      }
      
      let formatted;
      if (num >= 10000000) {
        formatted = `${(num / 10000000).toFixed(2)} Cr`;
      } else if (num >= 100000) {
        formatted = `${(num / 100000).toFixed(2)} L`;
      } else {
        formatted = num.toLocaleString('en-IN');
      }
      
      // Truncate if too long
      if (formatted.length > maxLength) {
        if (num >= 10000000) {
          formatted = `${(num / 10000000).toFixed(1)} Cr`;
        } else if (num >= 100000) {
          formatted = `${(num / 100000).toFixed(1)} L`;
        }
      }
      
      return formatted;
    };
    
    // Truncate text if too long
    const truncateText = (text, maxLength = 50) => {
      if (!text || text.length <= maxLength) return text;
      return text.substring(0, maxLength - 3) + '...';
    };
    
    // Check if hospital's metric is better than Eyther's promise
    const shouldShowMetric = (currentValue, eytherTarget, metricType) => {
      // For denial rate: lower is better, so don't show if hospital's rate < 3%
      if (metricType === 'denialRate') {
        return currentValue >= eytherTarget;
      }
      // For first pass rate: higher is better, so don't show if hospital's rate > 70%
      if (metricType === 'firstPassRate') {
        return currentValue <= eytherTarget;
      }
      // For query resolution time: lower is better
      if (metricType === 'queryResolution') {
        return currentValue >= eytherTarget;
      }
      return true;
    };
    
    // Prepare template data
    const templateData = {
      // Basic info
      hospitalName: truncateText(additionalParams.hospitalName || 'Hospital', 40),
      hospitalLocation: truncateText(additionalParams.hospitalLocation || `${additionalParams.hospitalName || 'Hospital'}, Location`, 60),
      contactPerson: truncateText(additionalParams.contactPerson || '', 30),
      email: truncateText(additionalParams.email || '', 40),
      title: truncateText(additionalParams.title || '', 30),
      proposalDate: new Date().toLocaleDateString('en-IN'),
      
      // Eyther Team Contact information
      contactEmail: additionalParams.eytherContactEmail || 'contact@eyther.ai',
      contactPhone: additionalParams.eytherContactPhone || '+91 98765 43210',
      teamMemberName: additionalParams.eytherTeamMember || 'Eyther Team',
      
      // Conditional metrics display flags
      showDenialMetric: shouldShowMetric(metrics.denialRate, 3, 'denialRate'),
      showFirstPassMetric: shouldShowMetric(metrics.firstPassRate, 70, 'firstPassRate'),
      showQueryMetric: true, // Always show query resolution metric
      
      // Key metrics
      revenueLeakage: formatIndianNumber(metrics.rejectedClaimsAmount),
      denialRate: metrics.denialRate.toFixed(1),
      roiMultiple: roiProjections.roiMultiple,
      
      // Analysis data
      totalClaims: metrics.totalClaims.toLocaleString('en-IN'),
      analysisStartDate: metrics.minDate ? metrics.minDate.toLocaleDateString('en-IN') : 'N/A',
      analysisEndDate: metrics.maxDate ? metrics.maxDate.toLocaleDateString('en-IN') : 'N/A',
      averageClaimAmount: metrics.averageClaimAmount > 0 ? formatIndianNumber(Math.round(metrics.averageClaimAmount)) : '50,000',
      
      // Performance metrics
      cleanClaimRate: metrics.firstPassRate.toFixed(0),
      cleanClaimOpportunity: Math.max(0, 95 - metrics.firstPassRate).toFixed(0),
      avgLengthOfStay: metrics.avgLengthOfStay ? Math.round(metrics.avgLengthOfStay) : 4,
      avgDaysToPayment: metrics.avgDaysToPayment > 0 ? `${Math.round(metrics.avgDaysToPayment)} days` : '45 days',
      daysReduction: Math.max(0, metrics.avgDaysToPayment - 30),
      firstPassRate: metrics.firstPassRate.toFixed(0),
      firstPassOpportunity: Math.max(0, 90 - metrics.firstPassRate).toFixed(0),
      leakageRate: metrics.revenueLeakageRate.toFixed(1),
      leakageAmount: formatIndianNumber(metrics.rejectedClaimsAmount),
      
      // Denial reasons
      denialReason1: metrics.denialReasons[0]?.reason || 'Documentation issues',
      denialPercentage1: metrics.denialReasons[0]?.percentage || 35,
      denialReason2: metrics.denialReasons[1]?.reason || 'Authorization issues',
      denialPercentage2: metrics.denialReasons[1]?.percentage || 25,
      denialReason3: metrics.denialReasons[2]?.reason || 'Coding errors',
      denialPercentage3: metrics.denialReasons[2]?.percentage || 20,
      denialReason4: metrics.denialReasons[3]?.reason || 'Eligibility issues',
      denialPercentage4: metrics.denialReasons[3]?.percentage || 12,
      denialReason5: metrics.denialReasons[4]?.reason || 'Timely filing issues',
      denialPercentage5: metrics.denialReasons[4]?.percentage || 8,
      
      // ROI projections
      denialPreventionConservative: formatIndianNumber(roiProjections.denialPreventionConservative),
      denialPreventionExpected: formatIndianNumber(roiProjections.denialPreventionExpected),
      denialPreventionOptimistic: formatIndianNumber(roiProjections.denialPreventionOptimistic),
      collectionsConservative: formatIndianNumber(roiProjections.collectionsConservative),
      collectionsExpected: formatIndianNumber(roiProjections.collectionsExpected),
      collectionsOptimistic: formatIndianNumber(roiProjections.collectionsOptimistic),
      efficiencyConservative: formatIndianNumber(roiProjections.efficiencyConservative),
      efficiencyExpected: formatIndianNumber(roiProjections.efficiencyExpected),
      efficiencyOptimistic: formatIndianNumber(roiProjections.efficiencyOptimistic),
      totalBenefitConservative: formatIndianNumber(roiProjections.totalBenefitConservative),
      totalBenefitExpected: formatIndianNumber(roiProjections.totalBenefitExpected),
      totalBenefitOptimistic: formatIndianNumber(roiProjections.totalBenefitOptimistic),
      paybackPeriod: roiProjections.paybackPeriod,
      
      // Additional variables for template compatibility
      monthlyClaimValue: formatIndianNumber(metrics.totalClaimValue / metrics.monthsSpan),
      primaryDepartments: 'Emergency, ICU, General Medicine, Surgery',
      monthlyPatientVolume: '2,500 patients',
      insuranceMix: 'RGHS: 40%, PMJAY: 30%, Private: 20%, Cash: 10%',
      currentProcessingTime: '45-60 minutes',
      currentReconciliationTime: '5-7 days',
      calculatedAnnualImpact: formatIndianNumber(roiProjections.totalBenefitExpected),
      
      // Sample financial calculation
      denialReductionCurrent: '₹7.5 Lakhs',
      denialReductionOptimized: '₹1.5 Lakhs',
      denialReductionSavings: '₹6.0 Lakhs',
      denialReductionAnnual: '₹72.0 Lakhs',
      firstPassCurrent: '₹20 Lakhs',
      firstPassOptimized: '₹15 Lakhs',
      firstPassSavings: '₹2.5 Lakhs',
      firstPassAnnual: '₹30.0 Lakhs',
      arReductionCurrent: '₹83.3 Lakhs',
      arReductionOptimized: '₹53.3 Lakhs',
      arReductionSavings: '₹3.0 Lakhs',
      arReductionAnnual: '₹36.0 Lakhs',
      adminEfficiencyCurrent: '₹4.0 Lakhs',
      adminEfficiencyOptimized: '₹1.0 Lakhs',
      adminEfficiencySavings: '₹3.0 Lakhs',
      adminEfficiencyAnnual: '₹36.0 Lakhs',
      totalMonthlyImpact: '₹14.5 Lakhs',
      totalAnnualImpact: '₹1.74 Crores',
      
      // Current challenges placeholders
      reconciliationGaps: '[CURRENT RECONCILIATION GAPS]',
      terminologyGaps: '[CLAIMS TEAM KNOWLEDGE GAPS]',
      packageErrors: '[PACKAGE BOOKING ERRORS]',
      documentationChallenges: '[DOCUMENTATION CHALLENGES]',
      authorizationTime: '[AUTHORIZATION PROCESSING TIME]',
      complianceIssues: '[SCHEME COMPLIANCE ISSUES]',
      
      // Timeline placeholders
      contractDate: 'Within 15 days',
      implementationStartDate: 'Within 30 days',
      pilotCompletionDate: 'Within 90 days'
    };
    
    return {
      success: true,
      metrics,
      roiProjections,
      templateData
    };
    
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
};

// Export for use in other modules
export default {
  parseCSVFile,
  validateMAAClaims,
  preprocessMAAClaims,
  groupDataByTID,
  calculateProposalMetrics,
  calculateROIProjections,
  processCSVForProposal
};