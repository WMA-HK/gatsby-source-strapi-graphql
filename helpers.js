const { print } = require("graphql");
const { createRemoteFileNode } = require(`gatsby-source-filesystem`);
const commonmark = require('commonmark');

const reader = new commonmark.Parser();
const excludedTypes = ['GenericMorph'];

const catchErrors = (err, operation, reporter) => {
  if (err?.networkError?.result?.errors) {
    err.networkError.result.errors.forEach(error => {
      reportOperationError(reporter, operation, error);
    });
  } else if (err?.graphQLErrors) {
    err.graphQLErrors.forEach(error => {
      reportOperationError(reporter, operation, error);
    });
  } else {
    reportOperationError(reporter, operation, err);
  }
};

const filterExcludedTypes = node => {
  const type = getTypeName(node.type);
  return !excludedTypes.includes(type);
};

const formatCollectionName = name => {
  return name
    .replace(/([a-z])([A-Z])/, '$1 $2')
    .replace(/\w+/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .replace(/\W+/g, '');
}

const getFieldType = (type, strapi = false) => {
  if (type.name === 'DateTime') {
    return 'String';
  }
  switch (type.kind) {
    case 'ENUM':
      return 'String';
    case 'LIST':
      return `[${getFieldType(type.ofType)}]`;
    case 'NON_NULL':
      return `${getFieldType(type.ofType)}!`;
    case 'OBJECT':
    case 'UNION':
      return `Strapi${type.name}`;
    default:
      return type.name;
  }
}

const getTypeName = type => {
  if (type.name === 'DateTime') {
    return 'String';
  }
  switch (type.kind) {
    case 'ENUM':
      return 'String';
    case 'LIST':
      return getTypeName(type.ofType);
    case 'NON_NULL':
      return getTypeName(type.ofType);
    default:
      return type.name;
  }
}

const getEntityResponse = name =>
  name.match(/(.*)(?:EntityResponse)$/)?.[1];

const getEntityResponseCollection = name =>
  name.match(/(.*)(?:EntityResponseCollection)$/)?.[1];

const getCollectionType = name =>
  name.match(/(.*)(?:EntityResponse|RelationResponseCollection)$/)?.[1];

const getCollectionTypes = ({ collectionTypes }) =>
  ['UploadFile', ...collectionTypes].map(formatCollectionName);

const getCollectionTypeMap = collectionTypes =>
  (collectionTypes || []).reduce((ac, a) => ({ ...ac, [a]: true }), {});

const reportOperationError = (reporter, operation, error) => {
  const { operationName, field, collectionType, query, variables } = operation;
  const extra = `
===== QUERY =====
${print(query)}
===== VARIABLES =====
${JSON.stringify({ operationName, field, collectionType, variables }, null, 2)}
===== ERROR =====
`;
  reporter.error(`${operationName} failed – ${error.message}\n${extra}`, error);
};

const assignNodeIds = (obj, createNodeId) => {
  const fields = Object.keys(obj).reduce((acc, key) => {
    let value = obj?.[key];
    if (value?.__typename) {
      const collectionType = getEntityResponse(value.__typename);
      if (collectionType && value?.data?.id) {
        const nodeId = createNodeId(`Strapi${collectionType}-${value.data.id}`);
        value = { ...value, id: nodeId, nodeId: `Strapi${collectionType}-${value.data.id}` };
      } else {
        value = assignNodeIds(value, createNodeId);
      }
      Object.assign(acc, { [key]: value });
    } else if (value instanceof Array) {
      value = value.map(o => assignNodeIds(o, createNodeId));
      Object.assign(acc, { [key]: value });
    }
    return acc;
  }, {});

  if (Object.keys(fields).length > 0) {
    return { ...obj, ...fields };
  }
  return obj;
};

const extractFiles = text => {
  const files = [];
  // parse the markdown content
  const parsed = reader.parse(text)
  const walker = parsed.walker()
  let event, node

  while ((event = walker.next())) {
    node = event.node
    // process image nodes
    if (event.entering && node.type === 'image') {
      files.push(node.destination);
    }
  }

  return files;
};

const processFieldData = async (data, options) => {
  const { pluginOptions, nodeId, createNode, createNodeId, getCache } = options || {};
  const apiURL = pluginOptions?.apiURL;
  const markdownImages = pluginOptions?.markdownImages?.typesToParse;
  const __typename = data?.__typename;
  const output = JSON.parse(JSON.stringify(data));

  // Extract files and download.
  if (__typename === 'UploadFile' && data.url) {
    const fileNode = await createRemoteFileNode({
      url: `${apiURL}${data.url}`,
      parentNodeId: nodeId,
      createNode,
      createNodeId,
      getCache,
    });
    if (fileNode) {
      output.file = fileNode.id;
    }
  }
  // Extract markdown files and download.
  if (markdownImages?.[__typename]) {
    await Promise.all((markdownImages[__typename] || []).map(async field => {
      const files = extractFiles(data[field]);
      if (files?.length) {
        await Promise.all(files.map(async (url, index) => {
          const fileNode = await createRemoteFileNode({
            url: `${apiURL}${url}`,
            parentNodeId: nodeId,
            createNode,
            createNodeId,
            getCache,
          });
          if (fileNode) {
            if (!output?.[`${field}_images`]) {
              output[`${field}_images`] = [];
            }
            output[`${field}_images`][index] = fileNode.id;
          }
        }));
      }
    }));
  }

  await Promise.all(Object.keys(data).map(async key => {
    const value = data?.[key];
    if (value?.__typename) {
      const collectionType = getEntityResponse(value.__typename);
      if (collectionType && value?.data?.id) {
        output[key].id = createNodeId(`Strapi${collectionType}-${value.data.id}`);
      } else {
        output[key] = await processFieldData(value, options);
      }
    } else if (value instanceof Array) {
      output[key] = await Promise.all(value.map(item => processFieldData(item, options)));
    }
  }));

  return output;
}

module.exports = {
  assignNodeIds,
  catchErrors,
  filterExcludedTypes,
  formatCollectionName,
  getEntityResponseCollection,
  getCollectionType,
  getCollectionTypes,
  getCollectionTypeMap,
  getFieldType,
  getTypeName,
  processFieldData,
  reportOperationError,
};
