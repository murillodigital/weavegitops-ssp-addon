import { ClusterAddOn, ClusterInfo, ClusterPostDeploy, Team } from '@shapirov/cdk-eks-blueprint';
import { AWSError, SecretsManager } from "aws-sdk";
import { GetSecretValueResponse } from "aws-sdk/clients/secretsmanager";

export interface BootstrapRepository {
    /**
     * The SSH URI for the GitHub Repository used for bootstrapping team workloads
     */
    readonly URL: string;
    /**
     * The branch to track for continuous reconciliation
     */
    readonly branch: string;
    /**
     * The path in the repo to use as root for all bootstrap declarations
     */
    readonly path: string;
    /**
     * The name of the AWS Secrets Manager Secret to use for authentication, the secret should contain three keys:
     *      private_key
     *      public_key
     *      known_hosts
     */
    readonly secretName?: string;
    /**
     * The fetched Private Key from the secret
     */
    privateKey?: string;
    /**
     * The fetched Public Key from the secret
     */
    publicKey?: string;
    /**
     * The fetched Known Hosts from the secret
     */
    knownHosts?: string;
}

export class WeaveGitOpsAddOn implements ClusterAddOn, ClusterPostDeploy {

    readonly namespace: string;
    readonly bootstrapRepository: BootstrapRepository;

    constructor(bootstrapRepository: BootstrapRepository, namespace?: string) {
        this.namespace = namespace ?? "wego-system";
        this.bootstrapRepository = bootstrapRepository;
    }

    getSshKeyFromSecret(secretName: string): void {
        const client = new SecretsManager();
        let secret = "";
        client.getSecretValue({ SecretId: secretName }, function(err: AWSError, data: GetSecretValueResponse) {
            if (err) {
                if (err.code === 'DecryptionFailureException')
                    throw err;
                else if (err.code === 'InternalServiceErrorException')
                    throw err;
                else if (err.code === 'InvalidParameterException')
                    throw err;
                else if (err.code === 'InvalidRequestException')
                    throw err;
                else if (err.code === 'ResourceNotFoundException')
                    throw err;
            } else {
                if ('SecretString' in data) {
                    secret = data.SecretString ?? "";
                } else {
                    const secretDataBase64String = data.SecretBinary ?? "";
                    secret = secretDataBase64String.toString();
                }
            }
        });
        const secretObject = JSON.parse(secret);
        this.bootstrapRepository.privateKey = secretObject.private_key;
        this.bootstrapRepository.publicKey = secretObject.public_key;
        this.bootstrapRepository.knownHosts = secretObject.known_hosts;
    }

    base64EncodeContents(contents: string) {
        return Buffer.from(contents, 'binary').toString('base64');
    }

    deploy(clusterInfo: ClusterInfo): void {
        try {
            clusterInfo.cluster.addHelmChart("weave-gitops-core", {
                chart: "wego-core",
                repository: "https://murillodigital.github.io/wego-helm",
                version: '0.0.5',
                namespace: this.namespace,
            });
        } catch (err) {
            console.error(`Unable to complete Weave GitOps AddOn Core deployment - aborting with error ${err}`);
        }
    }

    postDeploy(clusterInfo: ClusterInfo, teams: Team[]): void {
        try {
            if (this.bootstrapRepository.secretName) {  
                this.getSshKeyFromSecret(this.bootstrapRepository.secretName);
            }
            if (!!this.bootstrapRepository.privateKey || !!this.bootstrapRepository.knownHosts) {
                throw "Required details for bootstrap repository access are missing, aborting";
            }
            clusterInfo.cluster.addHelmChart("weave-gitops-application", {
                chart: "wego-app",
                repository: "https://murillodigital.github.io/wego-helm",
                version: '0.0.1',
                namespace: this.namespace,
                values: {
                    applications: [
                        {
                            applicationName: clusterInfo.cluster.clusterName,
                            gitRepository: this.bootstrapRepository.URL,
                            privateKey: this.base64EncodeContents(this.bootstrapRepository.privateKey ?? ""),
                            knownHosts: this.base64EncodeContents(this.bootstrapRepository.knownHosts ?? ""),
                            path: this.bootstrapRepository.path,
                            branch: this.bootstrapRepository.branch,
                        }
                    ]
                }
            });
        } catch (err) {
            console.error(`Unable to complete Weave GitOps AddOn Bootstrapping - aborting with error ${err}`);
        }
    }
}