export type DeployedDemoCompanyLogo = Readonly<{
  clientId: string;
  clientName: string;
  previousLocalPath: string;
  publicPath: string;
  sourceStoragePath: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  sha256: string;
}>;

export const DEPLOYED_DEMO_COMPANY_LOGOS = Object.freeze([
  {
    clientId: "d0000000-0000-4000-8000-000000000001",
    clientName: "Amazon-demo",
    previousLocalPath: "demo/companies/nova-circuit.webp",
    publicPath: "demo/company-logos/amazon.png",
    sourceStoragePath: "d0000000-0000-4000-8000-000000000001/logo/1788144069165-logo.png",
    mimeType: "image/png",
    sha256: "8105d39e511819f92d8fbc2cb2230e4d0f7086d3695bdc349c740e514b845b4b"
  },
  {
    clientId: "d3000000-0000-4000-8000-000000000004",
    clientName: "Apple-demo",
    previousLocalPath: "demo/companies/north-star-devices.webp",
    publicPath: "demo/company-logos/apple.png",
    sourceStoragePath: "d3000000-0000-4000-8000-000000000004/logo/1788145722716-logo.png",
    mimeType: "image/png",
    sha256: "02e32f0fa9cdf2d16eaa1176f7b65e4c9cf2c5606fdeb33d11bdd04875bb1a51"
  },
  {
    clientId: "d3000000-0000-4000-8000-000000000016",
    clientName: "Bosch-demo",
    previousLocalPath: "demo/companies/sakura.webp",
    publicPath: "demo/company-logos/bosch.jpg",
    sourceStoragePath: "d3000000-0000-4000-8000-000000000016/logo/1788144206859-logo.jpg",
    mimeType: "image/jpeg",
    sha256: "e8b70adbfc2774781339724858156b700dbe8a886a37a328406ab5cab82d1d56"
  },
  {
    clientId: "d3000000-0000-4000-8000-000000000012",
    clientName: "Cisco-demo",
    previousLocalPath: "demo/companies/rhein-werk.webp",
    publicPath: "demo/company-logos/cisco.webp",
    sourceStoragePath: "d3000000-0000-4000-8000-000000000012/logo/1788144257164-logo.webp",
    mimeType: "image/webp",
    sha256: "5cd35d58a80a07f2343fbe34a33eecc1d4c81bf12926138875fc54f6455769c5"
  },
  {
    clientId: "d3000000-0000-4000-8000-000000000009",
    clientName: "Dell-demo",
    previousLocalPath: "demo/companies/lion-city.webp",
    publicPath: "demo/company-logos/dell.jpg",
    sourceStoragePath: "d3000000-0000-4000-8000-000000000009/logo/1788144312833-logo.jpg",
    mimeType: "image/jpeg",
    sha256: "783be5f5ee2d8ebf4f3ca9c222598b71cae09b9e54f992e9f46de30786894131"
  },
  {
    clientId: "d3000000-0000-4000-8000-000000000002",
    clientName: "Google-demo",
    previousLocalPath: "demo/companies/atlas-robotics.webp",
    publicPath: "demo/company-logos/google.png",
    sourceStoragePath: "d3000000-0000-4000-8000-000000000002/logo/1788144385231-logo.png",
    mimeType: "image/png",
    sha256: "31777521ff015f86fad0b6b2c7f63f74944c437f2b038eb32a110ca4e7627292"
  },
  {
    clientId: "d3000000-0000-4000-8000-000000000010",
    clientName: "HP-demo",
    previousLocalPath: "demo/companies/pearl-river.webp",
    publicPath: "demo/company-logos/hp.jpg",
    sourceStoragePath: "d3000000-0000-4000-8000-000000000010/logo/1788144446013-logo.jpg",
    mimeType: "image/jpeg",
    sha256: "4afbcfd1ae875d34be2b39dd0f71e9c4155587b07db7ade38b648d0bb32b88a5"
  },
  {
    clientId: "d3000000-0000-4000-8000-000000000011",
    clientName: "IBM-demo",
    previousLocalPath: "demo/companies/meridian-semi.webp",
    publicPath: "demo/company-logos/ibm.webp",
    sourceStoragePath: "d3000000-0000-4000-8000-000000000011/logo/1788144534175-logo.webp",
    mimeType: "image/webp",
    sha256: "7becd4d584c9750ddfd95ab32d5d0bba5741dd334197849c6ab40d782d7f0f86"
  },
  {
    clientId: "d3000000-0000-4000-8000-000000000006",
    clientName: "Intel-demo",
    previousLocalPath: "demo/companies/maple-grid.webp",
    publicPath: "demo/company-logos/intel.jpg",
    sourceStoragePath: "d3000000-0000-4000-8000-000000000006/logo/1788144745341-logo.jpg",
    mimeType: "image/jpeg",
    sha256: "6ed9504940124aeb743098e4e07220266535a068269d580536a11a8a796b6924"
  },
  {
    clientId: "d3000000-0000-4000-8000-000000000018",
    clientName: "Meta-demo",
    previousLocalPath: "demo/companies/iberia.webp",
    publicPath: "demo/company-logos/meta.jpg",
    sourceStoragePath: "d3000000-0000-4000-8000-000000000018/logo/1788144796123-logo.jpg",
    mimeType: "image/jpeg",
    sha256: "eaa1517be2f9b671d8b0f84b544397103b4d7c7e837d278f9c02b7d80d8f27d5"
  },
  {
    clientId: "d3000000-0000-4000-8000-000000000003",
    clientName: "Microsoft-demo",
    previousLocalPath: "demo/companies/andina-controls.webp",
    publicPath: "demo/company-logos/microsoft.jpg",
    sourceStoragePath: "d3000000-0000-4000-8000-000000000003/logo/1788144865032-logo.jpg",
    mimeType: "image/jpeg",
    sha256: "08c47277d69bc07756b7df4eda0634ee5c7699009fbcbb1bbf52dd2030d71fd8"
  },
  {
    clientId: "d3000000-0000-4000-8000-000000000005",
    clientName: "Nvidia-demo",
    previousLocalPath: "demo/companies/pacifica-energy.webp",
    publicPath: "demo/company-logos/nvidia.webp",
    sourceStoragePath: "d3000000-0000-4000-8000-000000000005/logo/1788144913554-logo.webp",
    mimeType: "image/webp",
    sha256: "fcee3f02a4c9b321566d9f9ca24e6a4fd62220a9d266bac46855e5b450df0558"
  },
  {
    clientId: "d3000000-0000-4000-8000-000000000013",
    clientName: "Oracle-demo",
    previousLocalPath: "demo/companies/hexagon.webp",
    publicPath: "demo/company-logos/oracle.jpg",
    sourceStoragePath: "d3000000-0000-4000-8000-000000000013/logo/1788144974050-logo.jpg",
    mimeType: "image/jpeg",
    sha256: "86014474b6b53064e0fb20708e75d7748be78f33d7526fe56b2663dbaa8c22c0"
  },
  {
    clientId: "d3000000-0000-4000-8000-000000000017",
    clientName: "Panasonic-demo",
    previousLocalPath: "demo/companies/britannia.webp",
    publicPath: "demo/company-logos/panasonic.jpg",
    sourceStoragePath: "d3000000-0000-4000-8000-000000000017/logo/1788145035058-logo.jpg",
    mimeType: "image/jpeg",
    sha256: "ea3a08eac80843409b8c5aaf875663bcd35dda2a3a591909e6135ebe5b4daa96"
  },
  {
    clientId: "d3000000-0000-4000-8000-000000000014",
    clientName: "Qualcomm-demo",
    previousLocalPath: "demo/companies/euro-nova.webp",
    publicPath: "demo/company-logos/qualcomm.png",
    sourceStoragePath: "d3000000-0000-4000-8000-000000000014/logo/1788145089280-logo.png",
    mimeType: "image/png",
    sha256: "b8aec50aeff3f918526755a93deec8d897404a6c88ce1fff31d775af2fb80f2e"
  },
  {
    clientId: "d3000000-0000-4000-8000-000000000007",
    clientName: "Samsung-demo",
    previousLocalPath: "demo/companies/blue-mesa.webp",
    publicPath: "demo/company-logos/samsung.png",
    sourceStoragePath: "d3000000-0000-4000-8000-000000000007/logo/1788145273259-logo.png",
    mimeType: "image/png",
    sha256: "20f06559b7cd75e9b348ea01eafdd631e764e010c299733169c5451d3f2fb045"
  },
  {
    clientId: "d3000000-0000-4000-8000-000000000015",
    clientName: "Siemens-demo",
    previousLocalPath: "demo/companies/azteca.webp",
    publicPath: "demo/company-logos/siemens.png",
    sourceStoragePath: "d3000000-0000-4000-8000-000000000015/logo/1788145333956-logo.png",
    mimeType: "image/png",
    sha256: "9a560d8e70ec0cc72d6da4763fc436b670e4a63251c73342dc71288247e8aab2"
  },
  {
    clientId: "d3000000-0000-4000-8000-000000000008",
    clientName: "Sony-demo",
    previousLocalPath: "demo/companies/liberty-motion.webp",
    publicPath: "demo/company-logos/sony.jpg",
    sourceStoragePath: "d3000000-0000-4000-8000-000000000008/logo/1788145382385-logo.jpg",
    mimeType: "image/jpeg",
    sha256: "ddb317397db2eebcc0c9341d6dffcbd52c19010bd91c58fcca5a9851161e2fa5"
  },
  {
    clientId: "d3000000-0000-4000-8000-000000000019",
    clientName: "Tesla-demo",
    previousLocalPath: "demo/companies/southern-cross.webp",
    publicPath: "demo/company-logos/tesla.png",
    sourceStoragePath: "d3000000-0000-4000-8000-000000000019/logo/1788145771455-logo.png",
    mimeType: "image/png",
    sha256: "e2e32baf376627f85b1e4e5d34eae7cfc5882df9499ddc793b06b5867ec282dc"
  }
] as const satisfies readonly DeployedDemoCompanyLogo[]);

const DEPLOYED_DEMO_COMPANY_LOGO_BY_CLIENT_ID = new Map<string, DeployedDemoCompanyLogo>(
  DEPLOYED_DEMO_COMPANY_LOGOS.map((asset) => [asset.clientId, asset])
);

export function deployedDemoCompanyLogoUrl(clientId: string, logoPath: string | null) {
  if (!logoPath) return null;
  const asset = DEPLOYED_DEMO_COMPANY_LOGO_BY_CLIENT_ID.get(clientId);
  if (!asset) return null;

  const normalizedPath = logoPath.replace(/^\/+/, "");
  if (normalizedPath !== asset.previousLocalPath && normalizedPath !== asset.publicPath) {
    return null;
  }

  return `/${asset.publicPath}`;
}
