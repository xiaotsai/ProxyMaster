export namespace main {
	
	export class CheckResult {
	    latency: number;
	    success: boolean;
	    country: string;
	
	    static createFrom(source: any = {}) {
	        return new CheckResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.latency = source["latency"];
	        this.success = source["success"];
	        this.country = source["country"];
	    }
	}
	export class Proxy {
	    id: string;
	    ip: string;
	    port: string;
	    country: string;
	    latency: number;
	    status: string;
	    source: string;
	
	    static createFrom(source: any = {}) {
	        return new Proxy(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.ip = source["ip"];
	        this.port = source["port"];
	        this.country = source["country"];
	        this.latency = source["latency"];
	        this.status = source["status"];
	        this.source = source["source"];
	    }
	}

}

