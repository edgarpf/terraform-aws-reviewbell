import { createHmac } from "crypto";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import {
  DeleteParameterCommand,
  GetParameterCommand,
  PutParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  DynamoDbConfig,
  FlociContainer,
  LambdaConfig,
  SsmConfig,
  type StartedFlociContainer,
} from "@floci/testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lambdaEvent } from "../helpers/harness";
import { prEvent } from "../helpers/github-fixtures";

const integrationEnabled = process.env.REVIEWBELL_INTEGRATION === "1";
const fixtureDirectory = fileURLToPath(new URL("./terraform", import.meta.url));

function terraform(floci: StartedFlociContainer, ...args: string[]): string {
  return execFileSync(process.env.TERRAFORM_BIN ?? "terraform", args, {
    cwd: fixtureDirectory,
    encoding: "utf8",
    env: {
      ...process.env,
      AWS_ACCESS_KEY_ID: floci.getAccessKey(),
      AWS_SECRET_ACCESS_KEY: floci.getSecretKey(),
      AWS_REGION: floci.getRegion(),
      TF_IN_AUTOMATION: "1",
    },
    timeout: 240_000,
  });
}

function invokePayload(payload: Uint8Array | undefined) {
  if (!payload) throw new Error("Lambda returned no payload");
  return JSON.parse(Buffer.from(payload).toString("utf8")) as {
    statusCode: number;
    body: string;
  };
}

describe.skipIf(!integrationEnabled)("Floci deployed-module integration", () => {
  let floci: StartedFlociContainer;
  let dynamodb: DynamoDBClient;
  let documentClient: DynamoDBDocumentClient;
  let ssm: SSMClient;
  let lambda: LambdaClient;
  let functionName: string;
  let tableName: string;
  let terraformInitialized = false;
  const sdkTable = "reviewbell-sdk-smoke";
  const sdkParameter = "/reviewbell/sdk-smoke";

  beforeAll(async () => {
    floci = await new FlociContainer("floci/floci:2.0.1")
      .withDedicatedNetwork()
      .withDynamoDbConfig(new DynamoDbConfig(true))
      .withSsmConfig(new SsmConfig(true))
      .withLambdaConfig(new LambdaConfig(true, 256, 30, false, false))
      .start();

    const awsConfig = {
      endpoint: floci.getEndpoint(),
      region: floci.getRegion(),
      credentials: {
        accessKeyId: floci.getAccessKey(),
        secretAccessKey: floci.getSecretKey(),
      },
    };
    dynamodb = new DynamoDBClient(awsConfig);
    documentClient = DynamoDBDocumentClient.from(dynamodb);
    ssm = new SSMClient(awsConfig);
    lambda = new LambdaClient(awsConfig);

    await dynamodb.send(
      new CreateTableCommand({
        TableName: sdkTable,
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [{ AttributeName: "repo_pr", KeyType: "HASH" }],
        AttributeDefinitions: [{ AttributeName: "repo_pr", AttributeType: "S" }],
      }),
    );
    await waitUntilTableExists(
      { client: dynamodb, maxWaitTime: 30 },
      { TableName: sdkTable },
    );
    await ssm.send(
      new PutParameterCommand({
        Name: sdkParameter,
        Type: "SecureString",
        Value: "sdk-adapter-ok",
      }),
    );

    terraform(floci, "init", "-backend=false", "-input=false");
    terraformInitialized = true;
    terraform(
      floci,
      "apply",
      "-auto-approve",
      "-input=false",
      `-var=endpoint=${floci.getEndpoint()}`,
      `-var=region=${floci.getRegion()}`,
    );
    const outputs = JSON.parse(terraform(floci, "output", "-json")) as Record<
      string,
      { value: string }
    >;
    functionName = outputs.function_name.value;
    tableName = outputs.table_name.value;
  }, 300_000);

  afterAll(async () => {
    if (!floci) return;
    try {
      if (terraformInitialized) {
        terraform(
          floci,
          "destroy",
          "-auto-approve",
          "-input=false",
          `-var=endpoint=${floci.getEndpoint()}`,
          `-var=region=${floci.getRegion()}`,
        );
      }
      await ssm?.send(new DeleteParameterCommand({ Name: sdkParameter }));
      await dynamodb?.send(new DeleteTableCommand({ TableName: sdkTable }));
    } finally {
      await floci.stop();
    }
  }, 300_000);

  it("uses real SDK adapters for DynamoDB and SecureString SSM", async () => {
    const parameter = await ssm.send(
      new GetParameterCommand({ Name: sdkParameter, WithDecryption: true }),
    );
    expect(parameter.Parameter?.Value).toBe("sdk-adapter-ok");
    expect(tableName).toBe("reviewbell-integration-pr-messages");
  });

  it("invokes a signed draft webhook, persists state, deduplicates, and rejects bad HMAC", async () => {
    const payload = prEvent({ draft: true });
    const event = lambdaEvent("pull_request", payload, {
      deliveryId: "floci-draft-delivery",
      secret: "integration-secret",
    });
    const first = invokePayload(
      (
        await lambda.send(
          new InvokeCommand({
            FunctionName: functionName,
            Payload: Buffer.from(JSON.stringify(event)),
          }),
        )
      ).Payload,
    );
    expect(first.statusCode).toBe(200);

    const stored = await documentClient.send(
      new GetCommand({ TableName: tableName, Key: { repo_pr: "acme/widget#42" } }),
    );
    expect(stored.Item).toMatchObject({ status: "draft", routes: [] });

    const second = invokePayload(
      (
        await lambda.send(
          new InvokeCommand({
            FunctionName: functionName,
            Payload: Buffer.from(JSON.stringify(event)),
          }),
        )
      ).Payload,
    );
    expect(JSON.parse(second.body)).toMatchObject({ ok: true, dedup: true });

    const invalidBody = JSON.stringify(payload);
    const invalid = lambdaEvent("pull_request", payload, {
      deliveryId: "floci-invalid-signature",
      signature: `sha256=${createHmac("sha256", "wrong-secret").update(invalidBody).digest("hex")}`,
      rawBody: invalidBody,
    });
    const rejected = invokePayload(
      (
        await lambda.send(
          new InvokeCommand({
            FunctionName: functionName,
            Payload: Buffer.from(JSON.stringify(invalid)),
          }),
        )
      ).Payload,
    );
    expect(rejected.statusCode).toBe(401);
    const unclaimed = await documentClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { repo_pr: "delivery#floci-invalid-signature" },
      }),
    );
    expect(unclaimed.Item).toBeUndefined();
  });
});
