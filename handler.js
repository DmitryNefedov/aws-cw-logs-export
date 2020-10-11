const AWS = require("aws-sdk");
const moment = require('moment');
const _ = require('lodash');

const bucketName = process.env.LOGS_BUCKET_NAME;
const maxExportDays = process.env.MAX_RETENTION;
const region = process.env.REGION;

const cwlClient = new AWS.CloudWatchLogs({region: region});

let allLogGroups = [];
let taskResults = {};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const listAllCwLogGroups = async (nextToken) => {
  let params = {
    ...(nextToken && {nextToken})
  };

  const logGroups = await cwlClient.describeLogGroups(params).promise();

  if (logGroups.logGroups) {
    allLogGroups = allLogGroups.concat(logGroups.logGroups);
  }

  //describeLogGroups has a max limit of 50 groups, need to use nextToken to get all groups
  if (logGroups.nextToken) {
    await listAllCwLogGroups(logGroups.nextToken);
  }
};

async function checkExportTaskStatus(taskName, taskId) {
  const describeTaskResp = await cwlClient.describeExportTasks({taskId: taskId}).promise();
  const status = describeTaskResp.exportTasks[0].status.code;
  console.log(`${taskName} status is ${status}`);

  return status;
}

async function createExportTask(logGroup) {
  console.log(`Creating export task for ${logGroup.logGroupName}`);

  const timeNow = moment.utc();
  const taskName = `exportTaskFor-${logGroup.logGroupName}`;
  const fromDays = _.min([logGroup.retentionInDays, maxExportDays]);
  let destinationPrefix = logGroup.logGroupName;

  // remove first '/' from /aws/lambda/{lambdaName} to keep s3 sane and happy
  if (destinationPrefix[0] == '/') {
    destinationPrefix = destinationPrefix.substring(1);
  }

  const createTaskParams = {
    taskName: taskName,
    to: timeNow.add(1, 'minute').unix() * 1000,
    from: timeNow.subtract(fromDays, 'days').unix() * 1000,
    logGroupName: logGroup.logGroupName,
    destination: bucketName,
    destinationPrefix: destinationPrefix
  };

  const createTaskResp = await cwlClient.createExportTask(createTaskParams).promise();
  const taskId = createTaskResp.taskId;
  return {taskName, taskId};
}

const exportCwLogGroup = async (logGroup) => {

  const {taskName, taskId} = await createExportTask(logGroup);
  let exportTaskStatus = await checkExportTaskStatus(taskName, taskId);

  while (exportTaskStatus === 'PENDING' || exportTaskStatus === 'RUNNING') {
    await sleep(1000);
    exportTaskStatus = await checkExportTaskStatus(taskName, taskId);
  }

  console.log(`${logGroup.logGroupName} is finished with the result ${exportTaskStatus}`);
  taskResults[taskId] = {name: logGroup.logGroupName, status: exportTaskStatus};
};

const exportCwLogGroups = async (logGroups) => {
  // Each account can only have one active (RUNNING or PENDING) export task at a time.
  // need to wait until previous finished before start a new one
  // no parallel jobs :(
  for (const logGroup in logGroups) {
    await exportCwLogGroup(logGroups[logGroup]);
  }
};

const main = async () => {
  await listAllCwLogGroups();
  console.log(`Number of log groups in account is ${allLogGroups.length}`);

  await exportCwLogGroups(allLogGroups);
  console.log('All export asks are created');
  console.log(JSON.stringify(taskResults, null, 2));

  const tasksGroupedByStatus = _.groupBy(Object.keys(taskResults).map(key => {
    return {...taskResults[key], id: key};
  }), 'status');

  console.debug(`Extract tasks with statuses are ${JSON.stringify(tasksGroupedByStatus, null, 2)}`);

  console.log(`There are ${tasksGroupedByStatus['COMPLETED'].length} COMPLETED tasks out of ${allLogGroups.length}`);
  console.log(`Script completed`);
};

module.exports.handle = async event => {
  // reset global vars
  allLogGroups = [];
  taskResults = {};

  await main();
  return {
    statusCode: 200
  };
};
